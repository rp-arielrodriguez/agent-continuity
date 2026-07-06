package continuityd

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"sort"
	"strings"
	"time"
)

const peerRPCTimeout = 5 * time.Second

var lookupPeerIPAddrs = net.DefaultResolver.LookupIPAddr

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
	ProjectID        string         `json:"projectId"`
	TaskID           string         `json:"taskId"`
	LaneID           string         `json:"laneId"`
	Peers            []PeerSyncPeer `json:"peers"`
	AdvertisedBlocks int            `json:"advertisedBlocks"`
	MissingBlocks    int            `json:"missingBlocks"`
	FetchedBlocks    int            `json:"fetchedBlocks"`
	AcceptedBlocks   int            `json:"acceptedBlocks"`
	InsertedBlocks   int            `json:"insertedBlocks"`
	RejectedBlocks   int            `json:"rejectedBlocks"`
	FinalTip         string         `json:"finalTip,omitempty"`
}

type PeerSyncPeer struct {
	Endpoint           string                `json:"endpoint"`
	SelectedEndpoint   string                `json:"selectedEndpoint,omitempty"`
	CandidateEndpoints []PeerEndpointAttempt `json:"candidateEndpoints,omitempty"`
	Skipped            bool                  `json:"skipped,omitempty"`
	SkipReason         string                `json:"skipReason,omitempty"`
	Advertised         int                   `json:"advertised"`
	Missing            int                   `json:"missing"`
	Fetched            int                   `json:"fetched"`
	Accepted           int                   `json:"accepted"`
	Inserted           int                   `json:"inserted"`
	Rejected           []PeerSyncRejection   `json:"rejected,omitempty"`
	Error              string                `json:"error,omitempty"`
}

type PeerEndpointAttempt struct {
	Endpoint   string `json:"endpoint"`
	Advertised int    `json:"advertised,omitempty"`
	Missing    int    `json:"missing,omitempty"`
	Fetched    int    `json:"fetched,omitempty"`
	Error      string `json:"error,omitempty"`
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

type peerSyncTarget struct {
	Endpoint         string
	LastGoodEndpoint string
	NodeID           string
	Name             string
	SkipSelf         bool
}

func (s *Server) PeerSync(ctx context.Context, input PeerSyncInput) (PeerSyncResult, error) {
	ref := LaneRef{ProjectID: input.ProjectID, TaskID: input.TaskID, LaneID: input.LaneID}
	targets := make([]peerSyncTarget, 0, len(input.Peers))
	for _, endpoint := range input.Peers {
		targets = append(targets, peerSyncTarget{Endpoint: endpoint})
	}
	return s.peerSync(ctx, ref, targets, true)
}

func (s *Server) PeerSyncTrusted(ctx context.Context, input PeerSyncTrustedInput) (PeerSyncResult, error) {
	ref := LaneRef{ProjectID: input.ProjectID, TaskID: input.TaskID, LaneID: input.LaneID}
	peers, err := s.store.TrustedPeers(ctx, true)
	if err != nil {
		return PeerSyncResult{}, err
	}
	targets := make([]peerSyncTarget, 0, len(peers))
	for _, peer := range peers {
		targets = append(targets, peerSyncTarget{
			Endpoint:         peer.Endpoint,
			LastGoodEndpoint: peer.LastGoodEndpoint,
			NodeID:           peer.NodeID,
			Name:             peer.Name,
			SkipSelf:         true,
		})
	}
	return s.peerSync(ctx, ref, targets, false)
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

func (s *Server) peerSync(ctx context.Context, ref LaneRef, targets []peerSyncTarget, requirePeers bool) (PeerSyncResult, error) {
	if ref.ProjectID == "" || ref.TaskID == "" || ref.LaneID == "" {
		return PeerSyncResult{}, rpcInvalidParams(errors.New("projectId, taskId, and laneId are required"))
	}
	if requirePeers && len(targets) == 0 {
		return PeerSyncResult{}, rpcInvalidParams(errors.New("at least one peer endpoint is required"))
	}

	result := PeerSyncResult{
		ProjectID: ref.ProjectID,
		TaskID:    ref.TaskID,
		LaneID:    ref.LaneID,
		Peers:     []PeerSyncPeer{},
	}

	for _, target := range targets {
		peerResult := PeerSyncPeer{Endpoint: target.Endpoint}
		candidates := peerEndpointCandidates(ctx, target.Endpoint, target.LastGoodEndpoint)
		if target.SkipSelf {
			if skip, reason := isLikelySelfPeerEndpoint(target); skip {
				peerResult.Skipped = true
				peerResult.SkipReason = reason
				result.Peers = append(result.Peers, peerResult)
				continue
			}
		}

		blocks, advertised, missing, selectedEndpoint, attempts, err := s.fetchPeerDeltaBlocksFromCandidates(ctx, candidates, ref)
		peerResult.CandidateEndpoints = attempts
		if err != nil {
			peerResult.Error = err.Error()
			if touchErr := s.store.TouchTrustedPeerFailure(ctx, target.Endpoint, peerResult.Error, ""); touchErr != nil {
				return PeerSyncResult{}, touchErr
			}
			result.Peers = append(result.Peers, peerResult)
			continue
		}
		peerResult.SelectedEndpoint = selectedEndpoint
		peerResult.Advertised = advertised
		peerResult.Missing = missing
		peerResult.Fetched = len(blocks)
		result.AdvertisedBlocks += advertised
		result.MissingBlocks += missing
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
			if err := s.store.TouchTrustedPeerSuccess(ctx, target.Endpoint, selectedEndpoint, ""); err != nil {
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

func (s *Server) fetchPeerDeltaBlocksFromCandidates(ctx context.Context, candidates []string, ref LaneRef) ([]TaskBlock, int, int, string, []PeerEndpointAttempt, error) {
	attempts := make([]PeerEndpointAttempt, 0, len(candidates))
	errorsByEndpoint := make([]string, 0, len(candidates))
	for _, endpoint := range candidates {
		blocks, advertised, missing, err := s.fetchPeerDeltaBlocks(ctx, endpoint, ref)
		attempt := PeerEndpointAttempt{
			Endpoint:   endpoint,
			Advertised: advertised,
			Missing:    missing,
			Fetched:    len(blocks),
		}
		if err != nil {
			attempt.Error = err.Error()
			attempts = append(attempts, attempt)
			errorsByEndpoint = append(errorsByEndpoint, fmt.Sprintf("%s: %v", endpoint, err))
			continue
		}
		attempts = append(attempts, attempt)
		return blocks, advertised, missing, endpoint, attempts, nil
	}
	if len(errorsByEndpoint) == 0 {
		return nil, 0, 0, "", attempts, errors.New("no peer endpoint candidates")
	}
	return nil, 0, 0, "", attempts, fmt.Errorf("all peer endpoint candidates failed (%s)", strings.Join(errorsByEndpoint, "; "))
}

func (s *Server) fetchPeerDeltaBlocks(ctx context.Context, endpoint string, ref LaneRef) ([]TaskBlock, int, int, error) {
	inventory, err := fetchPeerInventory(ctx, endpoint, ref)
	if err != nil {
		blocks, fallbackErr := fetchPeerBlocks(ctx, endpoint, ref)
		if fallbackErr != nil {
			return nil, 0, 0, fmt.Errorf("inventory failed (%v); fallback lane.blocks failed: %w", err, fallbackErr)
		}
		return blocks, len(blocks), len(blocks), nil
	}

	missingIDs := make([]string, 0, len(inventory.Blocks))
	for _, entry := range inventory.Blocks {
		exists, err := s.store.HasBlock(ctx, entry.BlockID)
		if err != nil {
			return nil, len(inventory.Blocks), len(missingIDs), err
		}
		if !exists {
			missingIDs = append(missingIDs, entry.BlockID)
		}
	}
	if len(missingIDs) == 0 {
		return []TaskBlock{}, len(inventory.Blocks), 0, nil
	}

	blocks, err := fetchPeerBlocksByID(ctx, endpoint, ref, missingIDs)
	if err != nil {
		return nil, len(inventory.Blocks), len(missingIDs), err
	}
	requested := make(map[string]bool, len(missingIDs))
	for _, blockID := range missingIDs {
		requested[blockID] = true
	}
	for _, block := range blocks {
		if !requested[block.BlockID] {
			return nil, len(inventory.Blocks), len(missingIDs), fmt.Errorf("peer returned unrequested block %s", block.BlockID)
		}
		delete(requested, block.BlockID)
	}
	if len(requested) > 0 {
		return nil, len(inventory.Blocks), len(missingIDs), fmt.Errorf("peer advertised %d missing blocks but did not return %d of them", len(missingIDs), len(requested))
	}
	return blocks, len(inventory.Blocks), len(missingIDs), nil
}

func fetchPeerInventory(ctx context.Context, endpoint string, ref LaneRef) (LaneInventory, error) {
	var inventory LaneInventory
	if err := callPeerJSONRPC(ctx, endpoint, "lane.inventory", ref, &inventory); err != nil {
		return LaneInventory{}, err
	}
	return inventory, nil
}

func fetchPeerBlocksByID(ctx context.Context, endpoint string, ref LaneRef, blockIDs []string) ([]TaskBlock, error) {
	if len(blockIDs) == 0 {
		return []TaskBlock{}, nil
	}
	var blocks []TaskBlock
	input := LaneBlocksGetInput{ProjectID: ref.ProjectID, TaskID: ref.TaskID, LaneID: ref.LaneID, BlockIDs: blockIDs}
	if err := callPeerJSONRPC(ctx, endpoint, "lane.blocks.get", input, &blocks); err != nil {
		return nil, err
	}
	return blocks, nil
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
	dialer := &net.Dialer{Timeout: peerRPCTimeout}
	conn, err := dialPeerAddress(ctx, network, address, dialer)
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

type peerDialer interface {
	DialContext(ctx context.Context, network string, address string) (net.Conn, error)
}

func dialPeerAddress(ctx context.Context, network string, address string, dialer peerDialer) (net.Conn, error) {
	if network != "tcp" {
		return dialer.DialContext(ctx, network, address)
	}

	networks := peerTCPDialNetworks(address)
	errorsByNetwork := make([]string, 0, len(networks))
	for _, candidateNetwork := range networks {
		conn, err := dialer.DialContext(ctx, candidateNetwork, address)
		if err == nil {
			return conn, nil
		}
		errorsByNetwork = append(errorsByNetwork, fmt.Sprintf("%s: %v", candidateNetwork, err))
	}
	return nil, fmt.Errorf("all tcp dial attempts failed for %s (%s)", address, strings.Join(errorsByNetwork, "; "))
}

func peerTCPDialNetworks(address string) []string {
	host, _, err := net.SplitHostPort(address)
	if err != nil {
		return []string{"tcp"}
	}
	if strings.HasPrefix(host, "[") && strings.HasSuffix(host, "]") {
		host = strings.TrimPrefix(strings.TrimSuffix(host, "]"), "[")
	}
	hostWithoutZone := strings.Split(host, "%")[0]
	if net.ParseIP(hostWithoutZone) != nil {
		return []string{"tcp"}
	}
	return []string{"tcp4", "tcp6", "tcp"}
}

func peerEndpointCandidates(ctx context.Context, endpoint string, lastGoodEndpoint string) []string {
	candidates := make([]string, 0, 4)
	seen := map[string]bool{}
	add := func(candidate string) {
		if candidate == "" || seen[candidate] {
			return
		}
		seen[candidate] = true
		candidates = append(candidates, candidate)
	}

	add(lastGoodEndpoint)

	network, address, err := parsePeerEndpoint(endpoint)
	if err != nil || network != "tcp" {
		add(endpoint)
		return candidates
	}
	host, port, err := net.SplitHostPort(address)
	if err != nil {
		add(endpoint)
		return candidates
	}
	host = normalizePeerHost(host)
	if net.ParseIP(hostWithoutZone(host)) != nil {
		add(endpoint)
		return candidates
	}

	lookupCtx, cancel := context.WithTimeout(ctx, 750*time.Millisecond)
	defer cancel()
	addrs, err := lookupPeerIPAddrs(lookupCtx, host)
	if err != nil {
		add(endpoint)
		return candidates
	}
	sort.SliceStable(addrs, func(i, j int) bool {
		return peerIPRouteScore(addrs[i]) < peerIPRouteScore(addrs[j])
	})
	for _, addr := range addrs {
		add("tcp://" + net.JoinHostPort(addr.String(), port))
	}
	add(endpoint)
	return candidates
}

func isLikelySelfPeerEndpoint(target peerSyncTarget) (bool, string) {
	localNames := localPeerHostNames()
	for _, identity := range []string{target.NodeID, target.Name} {
		if identity == "" {
			continue
		}
		if localNames[strings.ToLower(strings.TrimSuffix(strings.TrimSpace(identity), "."))] {
			return true, "peer identity matches local node"
		}
	}

	network, address, err := parsePeerEndpoint(target.Endpoint)
	if err != nil || network != "tcp" {
		return false, ""
	}
	host, _, err := net.SplitHostPort(address)
	if err != nil {
		return false, ""
	}
	host = normalizePeerHost(host)
	if localNames[strings.ToLower(host)] {
		return true, "endpoint hostname matches local node"
	}
	return false, ""
}

func localPeerHostNames() map[string]bool {
	names := map[string]bool{"localhost": true}
	hostname, err := os.Hostname()
	if err != nil {
		return names
	}
	hostname = strings.TrimSuffix(strings.ToLower(strings.TrimSpace(hostname)), ".")
	if hostname == "" {
		return names
	}
	names[hostname] = true
	shortName := strings.Split(hostname, ".")[0]
	if shortName != "" {
		names[shortName] = true
		names[shortName+".local"] = true
	}
	return names
}

func peerIPRouteScore(addr net.IPAddr) int {
	ip := addr.IP
	if ip == nil {
		return 100
	}
	if ipv4 := ip.To4(); ipv4 != nil {
		switch {
		case ipv4[0] == 10:
			return 0
		case ipv4[0] == 172 && ipv4[1] >= 16 && ipv4[1] <= 31:
			return 0
		case ipv4[0] == 192 && ipv4[1] == 168:
			return 0
		case ipv4[0] == 100 && ipv4[1] >= 64 && ipv4[1] <= 127:
			return 0
		case ipv4[0] == 127:
			return 4
		default:
			return 1
		}
	}
	if ip.IsLinkLocalUnicast() {
		return 3
	}
	return 2
}

func normalizePeerHost(host string) string {
	host = strings.TrimSpace(host)
	host = strings.TrimPrefix(strings.TrimSuffix(host, "]"), "[")
	return strings.TrimSuffix(host, ".")
}

func hostWithoutZone(host string) string {
	return strings.Split(host, "%")[0]
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
