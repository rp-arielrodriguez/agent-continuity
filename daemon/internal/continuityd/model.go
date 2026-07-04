package continuityd

const (
	TaskBlockVersion = 1
	SignatureScheme  = "ed25519"
)

type LaneRef struct {
	ProjectID string `json:"projectId"`
	TaskID    string `json:"taskId"`
	LaneID    string `json:"laneId"`
}

type ActorRef struct {
	NodeID  string `json:"nodeId"`
	ActorID string `json:"actorId"`
}

type BlockSignature struct {
	Scheme    string `json:"scheme"`
	PublicKey string `json:"publicKey"`
	Value     string `json:"value"`
}

type TaskBlock struct {
	Version     int            `json:"version"`
	BlockID     string         `json:"blockId"`
	ProjectID   string         `json:"projectId"`
	TaskID      string         `json:"taskId"`
	LaneID      string         `json:"laneId"`
	Kind        string         `json:"kind"`
	ParentTips  []string       `json:"parentTips"`
	NodeID      string         `json:"nodeId"`
	ActorID     string         `json:"actorId"`
	LeaseEpoch  int64          `json:"leaseEpoch"`
	CreatedAt   string         `json:"createdAt"`
	PayloadHash string         `json:"payloadHash"`
	Payload     map[string]any `json:"payload"`
	Signature   BlockSignature `json:"signature"`
}

type LaneOwner struct {
	NodeID     string `json:"nodeId"`
	ActorID    string `json:"actorId"`
	LeaseEpoch int64  `json:"leaseEpoch"`
	LeaseUntil string `json:"leaseUntil,omitempty"`
}

type CheckpointProjection struct {
	Status   string `json:"status"`
	Progress string `json:"progress"`
	Files    string `json:"files,omitempty"`
	Blocking string `json:"blocking,omitempty"`
	Next     string `json:"next,omitempty"`
}

type LaneProjection struct {
	ProjectID         string                `json:"projectId"`
	TaskID            string                `json:"taskId"`
	LaneID            string                `json:"laneId"`
	Tip               string                `json:"tip,omitempty"`
	LeaseEpoch        int64                 `json:"leaseEpoch"`
	Owner             *LaneOwner            `json:"owner,omitempty"`
	CanonMarkdown     string                `json:"canonMarkdown,omitempty"`
	InventoryMarkdown string                `json:"inventoryMarkdown,omitempty"`
	Checkpoint        *CheckpointProjection `json:"checkpoint,omitempty"`
	UpdatedAt         string                `json:"updatedAt,omitempty"`
}

type TransitionAction string

const (
	ActionContinue  TransitionAction = "continue"
	ActionPause     TransitionAction = "pause"
	ActionReconcile TransitionAction = "reconcile"
)

type Rejection struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

type AppendBlockResult struct {
	Accepted  bool             `json:"accepted"`
	Inserted  bool             `json:"inserted"`
	Action    TransitionAction `json:"action"`
	Lane      LaneProjection   `json:"lane"`
	Block     *TaskBlock       `json:"block,omitempty"`
	Rejection *Rejection       `json:"rejection,omitempty"`
}

type StatusInput struct {
	ProjectID string    `json:"projectId"`
	TaskID    string    `json:"taskId"`
	LaneID    string    `json:"laneId"`
	Actor     *ActorRef `json:"actor,omitempty"`
	Now       string    `json:"now,omitempty"`
}

type StatusResult struct {
	Lane   LaneProjection   `json:"lane"`
	Action TransitionAction `json:"action"`
	Reason string           `json:"reason,omitempty"`
}

type HealthResult struct {
	OK       bool   `json:"ok"`
	Provider string `json:"provider"`
	Version  int    `json:"version"`
}

type TrustedPeer struct {
	Endpoint   string `json:"endpoint"`
	NodeID     string `json:"nodeId,omitempty"`
	Name       string `json:"name,omitempty"`
	PublicKey  string `json:"publicKey,omitempty"`
	Provider   string `json:"provider,omitempty"`
	Enabled    bool   `json:"enabled"`
	CreatedAt  string `json:"createdAt,omitempty"`
	UpdatedAt  string `json:"updatedAt,omitempty"`
	LastSeenAt string `json:"lastSeenAt,omitempty"`
}

func (b TaskBlock) LaneRef() LaneRef {
	return LaneRef{ProjectID: b.ProjectID, TaskID: b.TaskID, LaneID: b.LaneID}
}

func EmptyLaneProjection(ref LaneRef) LaneProjection {
	return LaneProjection{
		ProjectID:  ref.ProjectID,
		TaskID:     ref.TaskID,
		LaneID:     ref.LaneID,
		LeaseEpoch: 0,
	}
}
