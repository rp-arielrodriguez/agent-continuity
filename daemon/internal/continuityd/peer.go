package continuityd

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"strings"
	"time"
)

const peerRPCTimeout = 5 * time.Second

type PeerSyncInput struct {
	ProjectID string   `json:"projectId"`
	TaskID    string   `json:"taskId"`
	LaneID    string   `json:"laneId"`
	Peers     []string `json:"peers"`
}

type PeerSyncTrustedInput struct {
	ProjectID string `json:"projectId"`
	TaskID    string `json:"taskId"`
	LaneID    string `json:"laneId"`
}

type PeerSyncResult struct {
	ProjectID      string         `json:"projectId"`
	TaskID         string         `json:"taskId"`
	LaneID         string         `json:"laneId"`
	Peers          []PeerSyncPeer `json:"peers"`
	FetchedBlocks  int            `json:"fetchedBlocks"`
	AcceptedBlocks int            `json:"acceptedBlocks"`
	InsertedBlocks int            `json:"insertedBlocks"`
	RejectedBlocks int            `json:"rejectedBlocks"`
	FinalTip       string         `json:"finalTip,omitempty"`
}

type PeerSyncPeer struct {
	Endpoint string              `json:"endpoint"`
	Fetched  int                 `json:"fetched"`
	Accepted int                 `json:"accepted"`
	Inserted int                 `json:"inserted"`
	Rejected []PeerSyncRejection `json:"rejected,omitempty"`
	Error    string              `json:"error,omitempty"`
}

type PeerSyncRejection struct {
	BlockID string `json:"blockId"`
	Code    string `json:"code"`
	Message string `json:"message"`
}

type PeerTrustAddInput struct {
	Endpoint  string `json:"endpoint"`
	NodeID    string `json:"nodeId,omitempty"`
	Name      string `json:"name,omitempty"`
	PublicKey string `json:"publicKey,omitempty"`
	Provider  string `json:"provider,omitempty"`
	Enabled   *bool  `json:"enabled,omitempty"`
	Now       string `json:"now,omitempty"`
}

type PeerTrustListInput struct {
	IncludeDisabled bool `json:"includeDisabled,omitempty"`
}

type PeerTrustListResult struct {
	Peers []TrustedPeer `json:"peers"`
}

type PeerTrustRemoveInput struct {
	Endpoint string `json:"endpoint"`
}

type PeerTrustRemoveResult struct {
	Endpoint string `json:"endpoint"`
	Removed  bool   `json:"removed"`
}

func (s *Server) PeerSync(ctx context.Context, input PeerSyncInput) (PeerSyncResult, error) {
	ref := LaneRef{ProjectID: input.ProjectID, TaskID: input.TaskID, LaneID: input.LaneID}
	return s.peerSync(ctx, ref, input.Peers, true)
}

func (s *Server) PeerSyncTrusted(ctx context.Context, input PeerSyncTrustedInput) (PeerSyncResult, error) {
	ref := LaneRef{ProjectID: input.ProjectID, TaskID: input.TaskID, LaneID: input.LaneID}
	peers, err := s.store.TrustedPeers(ctx, true)
	if err != nil {
		return PeerSyncResult{}, err
	}
	endpoints := make([]string, 0, len(peers))
	for _, peer := range peers {
		endpoints = append(endpoints, peer.Endpoint)
	}
	return s.peerSync(ctx, ref, endpoints, false)
}

func (s *Server) TrustPeer(ctx context.Context, input PeerTrustAddInput) (TrustedPeer, error) {
	if input.Endpoint == "" {
		return TrustedPeer{}, rpcInvalidParams(errors.New("endpoint is required"))
	}
	if _, _, err := parsePeerEndpoint(input.Endpoint); err != nil {
		return TrustedPeer{}, rpcInvalidParams(err)
	}
	enabled := true
	if input.Enabled != nil {
		enabled = *input.Enabled
	}
	return s.store.UpsertTrustedPeer(ctx, TrustedPeer{
		Endpoint:  input.Endpoint,
		NodeID:    input.NodeID,
		Name:      input.Name,
		PublicKey: input.PublicKey,
		Provider:  input.Provider,
		Enabled:   enabled,
	}, input.Now)
}

func (s *Server) ListTrustedPeers(ctx context.Context, input PeerTrustListInput) (PeerTrustListResult, error) {
	peers, err := s.store.TrustedPeers(ctx, !input.IncludeDisabled)
	if err != nil {
		return PeerTrustListResult{}, err
	}
	return PeerTrustListResult{Peers: peers}, nil
}

func (s *Server) RemoveTrustedPeer(ctx context.Context, input PeerTrustRemoveInput) (PeerTrustRemoveResult, error) {
	if input.Endpoint == "" {
		return PeerTrustRemoveResult{}, rpcInvalidParams(errors.New("endpoint is required"))
	}
	removed, err := s.store.RemoveTrustedPeer(ctx, input.Endpoint)
	if err != nil {
		return PeerTrustRemoveResult{}, err
	}
	return PeerTrustRemoveResult{Endpoint: input.Endpoint, Removed: removed}, nil
}

func (s *Server) peerSync(ctx context.Context, ref LaneRef, endpoints []string, requirePeers bool) (PeerSyncResult, error) {
	if ref.ProjectID == "" || ref.TaskID == "" || ref.LaneID == "" {
		return PeerSyncResult{}, rpcInvalidParams(errors.New("projectId, taskId, and laneId are required"))
	}
	if requirePeers && len(endpoints) == 0 {
		return PeerSyncResult{}, rpcInvalidParams(errors.New("at least one peer endpoint is required"))
	}

	result := PeerSyncResult{
		ProjectID: ref.ProjectID,
		TaskID:    ref.TaskID,
		LaneID:    ref.LaneID,
		Peers:     []PeerSyncPeer{},
	}

	for _, endpoint := range endpoints {
		peerResult := PeerSyncPeer{Endpoint: endpoint}
		blocks, err := fetchPeerBlocks(ctx, endpoint, ref)
		if err != nil {
			peerResult.Error = err.Error()
			result.Peers = append(result.Peers, peerResult)
			continue
		}
		peerResult.Fetched = len(blocks)
		result.FetchedBlocks += len(blocks)

		for _, block := range blocks {
			appendResult, err := s.store.AppendBlock(ctx, block, "")
			if err != nil {
				peerResult.Error = err.Error()
				break
			}
			if appendResult.Accepted {
				peerResult.Accepted++
				result.AcceptedBlocks++
				if appendResult.Inserted {
					peerResult.Inserted++
					result.InsertedBlocks++
				}
				continue
			}
			rejection := PeerSyncRejection{BlockID: block.BlockID}
			if appendResult.Rejection != nil {
				rejection.Code = appendResult.Rejection.Code
				rejection.Message = appendResult.Rejection.Message
			}
			peerResult.Rejected = append(peerResult.Rejected, rejection)
			result.RejectedBlocks++
		}
		if peerResult.Error == "" {
			if err := s.store.TouchTrustedPeer(ctx, endpoint, ""); err != nil {
				return PeerSyncResult{}, err
			}
		}
		result.Peers = append(result.Peers, peerResult)
	}

	if lane, found, err := s.store.LaneProjection(ctx, ref); err != nil {
		return PeerSyncResult{}, err
	} else if found {
		result.FinalTip = lane.Tip
	}
	return result, nil
}

func fetchPeerBlocks(ctx context.Context, endpoint string, ref LaneRef) ([]TaskBlock, error) {
	var blocks []TaskBlock
	if err := callPeerJSONRPC(ctx, endpoint, "lane.blocks", ref, &blocks); err != nil {
		return nil, err
	}
	return blocks, nil
}

func callPeerJSONRPC(ctx context.Context, endpoint string, method string, params any, target any) error {
	network, address, err := parsePeerEndpoint(endpoint)
	if err != nil {
		return err
	}
	dialer := net.Dialer{Timeout: peerRPCTimeout}
	conn, err := dialer.DialContext(ctx, network, address)
	if err != nil {
		return fmt.Errorf("connect peer %s: %w", endpoint, err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(peerRPCTimeout))

	request := rpcRequest{
		JSONRPC: "2.0",
		ID:      fmt.Sprintf("peer-sync-%d", time.Now().UnixNano()),
		Method:  method,
	}
	paramsBytes, err := json.Marshal(params)
	if err != nil {
		return fmt.Errorf("encode peer params: %w", err)
	}
	request.Params = paramsBytes
	if err := json.NewEncoder(conn).Encode(request); err != nil {
		return fmt.Errorf("write peer request: %w", err)
	}

	var response peerRPCResponse
	if err := json.NewDecoder(conn).Decode(&response); err != nil {
		return fmt.Errorf("read peer response: %w", err)
	}
	if response.Error != nil {
		return fmt.Errorf("peer RPC %s failed: %d %s", method, response.Error.Code, response.Error.Message)
	}
	if len(response.Result) == 0 {
		return errors.New("peer returned empty result")
	}
	if err := json.Unmarshal(response.Result, target); err != nil {
		return fmt.Errorf("decode peer result: %w", err)
	}
	return nil
}

func parsePeerEndpoint(endpoint string) (network string, address string, err error) {
	switch {
	case strings.HasPrefix(endpoint, "unix://"):
		address = strings.TrimPrefix(endpoint, "unix://")
		if address == "" {
			return "", "", errors.New("unix peer endpoint path is empty")
		}
		return "unix", address, nil
	case strings.HasPrefix(endpoint, "tcp://"):
		address = strings.TrimPrefix(endpoint, "tcp://")
		if address == "" {
			return "", "", errors.New("tcp peer endpoint address is empty")
		}
		return "tcp", address, nil
	case strings.HasPrefix(endpoint, "/"):
		return "unix", endpoint, nil
	default:
		return "", "", fmt.Errorf("unsupported peer endpoint %q: expected unix://<path> or tcp://<host:port>", endpoint)
	}
}

type peerRPCResponse struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      any             `json:"id,omitempty"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   *rpcError       `json:"error,omitempty"`
}
