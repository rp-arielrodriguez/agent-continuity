package continuityd

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
)

type Server struct {
	store *SQLiteStore
	mdns  *MDNSAdvertiser
}

func NewServer(store *SQLiteStore) *Server {
	return &Server{store: store, mdns: NewMDNSAdvertiser()}
}

func (s *Server) ServeUnix(ctx context.Context, socketPath string) error {
	if socketPath == "" {
		return errors.New("socket path is required")
	}
	_ = os.Remove(socketPath)
	listener, err := net.Listen("unix", socketPath)
	if err != nil {
		return fmt.Errorf("listen on unix socket %s: %w", socketPath, err)
	}
	defer listener.Close()
	defer os.Remove(socketPath)
	return s.serveListener(ctx, listener, false)
}

func (s *Server) ServeReadOnlyTCP(ctx context.Context, address string) error {
	if address == "" {
		return errors.New("tcp address is required")
	}
	listener, err := net.Listen("tcp", address)
	if err != nil {
		return fmt.Errorf("listen on tcp address %s: %w", address, err)
	}
	defer listener.Close()
	return s.serveListener(ctx, listener, true)
}

func (s *Server) serveListener(ctx context.Context, listener net.Listener, readOnly bool) error {
	go func() {
		<-ctx.Done()
		_ = listener.Close()
	}()

	for {
		conn, err := listener.Accept()
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			return fmt.Errorf("accept json-rpc connection: %w", err)
		}
		go s.handleConn(ctx, conn, readOnly)
	}
}

func (s *Server) handleConn(ctx context.Context, conn net.Conn, readOnly bool) {
	defer conn.Close()
	decoder := json.NewDecoder(conn)
	encoder := json.NewEncoder(conn)
	for {
		var request rpcRequest
		if err := decoder.Decode(&request); err != nil {
			return
		}
		response := s.handleRequest(ctx, request, readOnly)
		if request.ID == nil && response.Error == nil {
			continue
		}
		_ = encoder.Encode(response)
	}
}

func (s *Server) handleRequest(ctx context.Context, request rpcRequest, readOnly bool) rpcResponse {
	if request.JSONRPC != "2.0" || request.Method == "" {
		return rpcErrorResponse(request.ID, -32600, "Invalid Request", nil)
	}
	if readOnly && !isReadOnlyMethod(request.Method) {
		return rpcErrorResponse(request.ID, -32601, "Method not available on read-only peer listener", request.Method)
	}

	result, err := s.dispatch(ctx, request.Method, request.Params)
	if err != nil {
		var rpcErr *rpcError
		if errors.As(err, &rpcErr) {
			return rpcResponse{JSONRPC: "2.0", ID: request.ID, Error: rpcErr}
		}
		return rpcErrorResponse(request.ID, -32603, "Internal error", err.Error())
	}
	return rpcResponse{JSONRPC: "2.0", ID: request.ID, Result: result}
}

func isReadOnlyMethod(method string) bool {
	switch method {
	case "daemon.health", "provider.health", "lane.status", "lane.blocks", "lane.blocks.get", "lane.inventory", "project.inventory", "blob.get":
		return true
	default:
		return false
	}
}

func (s *Server) dispatch(ctx context.Context, method string, params json.RawMessage) (any, error) {
	switch method {
	case "daemon.health", "provider.health":
		return HealthResult{OK: true, Provider: "continuityd", Version: 1}, nil
	case "lane.status":
		var input StatusInput
		if err := decodeParams(params, &input); err != nil {
			return nil, rpcInvalidParams(err)
		}
		return s.Status(ctx, input)
	case "lane.blocks":
		var input LaneRef
		if err := decodeParams(params, &input); err != nil {
			return nil, rpcInvalidParams(err)
		}
		return s.store.Blocks(ctx, input)
	case "lane.blocks.get":
		var input LaneBlocksGetInput
		if err := decodeParams(params, &input); err != nil {
			return nil, rpcInvalidParams(err)
		}
		return s.store.BlocksByID(ctx, LaneRef{ProjectID: input.ProjectID, TaskID: input.TaskID, LaneID: input.LaneID}, input.BlockIDs)
	case "lane.inventory":
		var input LaneRef
		if err := decodeParams(params, &input); err != nil {
			return nil, rpcInvalidParams(err)
		}
		return s.store.LaneInventory(ctx, input)
	case "project.inventory":
		var input ProjectLaneInventoryInput
		if err := decodeParams(params, &input); err != nil {
			return nil, rpcInvalidParams(err)
		}
		return s.store.ProjectInventory(ctx, input)
	case "blob.get":
		var input BlobGetInput
		if err := decodeParams(params, &input); err != nil {
			return nil, rpcInvalidParams(err)
		}
		return s.store.Blob(ctx, input.Digest)
	case "block.submit":
		var input submitBlockInput
		if err := decodeParams(params, &input); err != nil {
			return nil, rpcInvalidParams(err)
		}
		return s.store.AppendBlock(ctx, input.Block, input.Now)
	case "retention.apply":
		var input RetentionApplyInput
		if err := decodeParams(params, &input); err != nil {
			return nil, rpcInvalidParams(err)
		}
		return s.store.ApplyRetention(ctx, input)
	case "projection.rebuild":
		count, err := s.store.RebuildProjections(ctx)
		if err != nil {
			return nil, err
		}
		return map[string]int{"replayed": count}, nil
	case "peer.sync":
		var input PeerSyncInput
		if err := decodeParams(params, &input); err != nil {
			return nil, rpcInvalidParams(err)
		}
		return s.PeerSync(ctx, input)
	case "peer.syncTrusted":
		var input PeerSyncTrustedInput
		if err := decodeParams(params, &input); err != nil {
			return nil, rpcInvalidParams(err)
		}
		return s.PeerSyncTrusted(ctx, input)
	case "peer.trustAdd":
		var input PeerTrustAddInput
		if err := decodeParams(params, &input); err != nil {
			return nil, rpcInvalidParams(err)
		}
		return s.TrustPeer(ctx, input)
	case "peer.trustList":
		var input PeerTrustListInput
		if err := decodeParams(params, &input); err != nil {
			return nil, rpcInvalidParams(err)
		}
		return s.ListTrustedPeers(ctx, input)
	case "peer.trustRemove":
		var input PeerTrustRemoveInput
		if err := decodeParams(params, &input); err != nil {
			return nil, rpcInvalidParams(err)
		}
		return s.RemoveTrustedPeer(ctx, input)
	case "peer.discover":
		var input PeerDiscoverInput
		if err := decodeParams(params, &input); err != nil {
			return nil, rpcInvalidParams(err)
		}
		return DiscoverPeers(ctx, input)
	case "mdns.advertiseStart":
		var input MDNSAdvertiseStartInput
		if err := decodeParams(params, &input); err != nil {
			return nil, rpcInvalidParams(err)
		}
		result, err := s.mdns.Start(input)
		if errors.Is(err, ErrMDNSAdvertiserRunning) {
			return nil, &rpcError{Code: -32000, Message: "mDNS advertiser is already running"}
		}
		return result, err
	case "mdns.advertiseStatus":
		return s.mdns.Status(), nil
	case "mdns.advertiseStop":
		return s.mdns.Stop(), nil
	default:
		return nil, &rpcError{Code: -32601, Message: "Method not found"}
	}
}

func (s *Server) Status(ctx context.Context, input StatusInput) (StatusResult, error) {
	ref := LaneRef{ProjectID: input.ProjectID, TaskID: input.TaskID, LaneID: input.LaneID}
	lane, found, err := s.store.LaneProjection(ctx, ref)
	if err != nil {
		return StatusResult{}, err
	}
	if !found {
		lane = EmptyLaneProjection(ref)
	}
	action := ActionContinue
	reason := ""
	if input.Actor != nil {
		action = LaneActionForActor(lane, *input.Actor, input.Now)
		if action == ActionPause && lane.Owner != nil {
			reason = fmt.Sprintf("lane is owned by %s/%s", lane.Owner.NodeID, lane.Owner.ActorID)
		}
	}
	return StatusResult{Lane: lane, Action: action, Reason: reason}, nil
}

type submitBlockInput struct {
	Block TaskBlock `json:"block"`
	Now   string    `json:"now,omitempty"`
}

type rpcRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      any             `json:"id,omitempty"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
}

type rpcResponse struct {
	JSONRPC string    `json:"jsonrpc"`
	ID      any       `json:"id,omitempty"`
	Result  any       `json:"result,omitempty"`
	Error   *rpcError `json:"error,omitempty"`
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
	Data    any    `json:"data,omitempty"`
}

func (e *rpcError) Error() string {
	return e.Message
}

func rpcErrorResponse(id any, code int, message string, data any) rpcResponse {
	return rpcResponse{JSONRPC: "2.0", ID: id, Error: &rpcError{Code: code, Message: message, Data: data}}
}

func rpcInvalidParams(err error) error {
	return &rpcError{Code: -32602, Message: "Invalid params", Data: err.Error()}
}

func decodeParams(params json.RawMessage, target any) error {
	if len(params) == 0 {
		params = []byte(`{}`)
	}
	if err := json.Unmarshal(params, target); err != nil {
		return err
	}
	return nil
}
