package continuityd

import (
	"fmt"
	"strings"
	"time"
)

const defaultLeaseGrace = 30 * time.Second

type TransitionContext struct {
	Current  *LaneProjection
	HasBlock func(blockID string) bool
	Now      string
}

type TransitionResult struct {
	OK        bool
	Action    TransitionAction
	Rejection *Rejection
}

func ValidateBlockTransition(block TaskBlock, ctx TransitionContext) TransitionResult {
	if issues := ValidateTaskBlock(block); len(issues) > 0 {
		parts := make([]string, 0, len(issues))
		for _, issue := range issues {
			parts = append(parts, issue.Code+": "+issue.Message)
		}
		return reject(ActionReconcile, "invalid_block", strings.Join(parts, "; "))
	}
	if ctx.Current != nil && !sameLane(block.LaneRef(), LaneRef{ProjectID: ctx.Current.ProjectID, TaskID: ctx.Current.TaskID, LaneID: ctx.Current.LaneID}) {
		return reject(ActionReconcile, "invalid_block", "block lane does not match transition context")
	}
	if block.Kind != "lane_snapshot" {
		for _, tip := range block.ParentTips {
			if ctx.HasBlock == nil || !ctx.HasBlock(tip) {
				return reject(ActionReconcile, "unknown_parent_tip", "block references a parent tip that is not known locally")
			}
		}
	}

	switch block.Kind {
	case "bootstrap":
		return validateBootstrap(block, ctx.Current)
	case "claim_lane":
		return validateClaim(block, ctx)
	case "heartbeat", "checkpoint", "canon_update", "handoff", "release":
		return validateOwnedTipBlock(block, ctx.Current, block.Kind)
	case "inventory_update", "pause":
		return validateTipExtendingBlock(block, ctx.Current, block.Kind)
	case "lane_snapshot":
		return validateLaneSnapshot(block, ctx.Current)
	case "reconcile":
		return validateReconcile(block, ctx)
	case "task_intent", "worker_profile", "task_assignment", "task_result", "task_adjudication":
		return validateSchedulerBlock(block, ctx.Current, block.Kind)
	default:
		return reject(ActionReconcile, "invalid_block", "unsupported task block kind "+block.Kind)
	}
}

func ApplyBlockToProjection(current *LaneProjection, block TaskBlock) LaneProjection {
	var next LaneProjection
	if current == nil {
		next = EmptyLaneProjection(block.LaneRef())
	} else {
		next = *current
	}
	next.Tip = block.BlockID
	next.Heads = nextHeads(current, block)
	if block.LeaseEpoch > next.LeaseEpoch {
		next.LeaseEpoch = block.LeaseEpoch
	}
	next.UpdatedAt = block.CreatedAt

	switch block.Kind {
	case "bootstrap":
		if value := payloadString(block.Payload, "canonMarkdown"); value != "" {
			next.CanonMarkdown = value
		}
		if value := payloadString(block.Payload, "inventoryMarkdown"); value != "" {
			next.InventoryMarkdown = value
		}
	case "claim_lane", "heartbeat":
		next.Owner = &LaneOwner{
			NodeID:     block.NodeID,
			ActorID:    block.ActorID,
			LeaseEpoch: block.LeaseEpoch,
			LeaseUntil: payloadString(block.Payload, "leaseUntil"),
		}
	case "checkpoint":
		next.Checkpoint = &CheckpointProjection{
			Status:   payloadString(block.Payload, "status"),
			Progress: payloadString(block.Payload, "progress"),
			Files:    payloadString(block.Payload, "files"),
			Blocking: payloadString(block.Payload, "blocking"),
			Next:     payloadString(block.Payload, "next"),
		}
		if value := payloadString(block.Payload, "canonMarkdown"); value != "" {
			next.CanonMarkdown = value
		}
	case "canon_update":
		next.CanonMarkdown = payloadString(block.Payload, "canonMarkdown")
	case "inventory_update":
		next.InventoryMarkdown = payloadString(block.Payload, "inventoryMarkdown")
	case "handoff":
		nodeID := payloadString(block.Payload, "targetNodeId")
		if nodeID == "" {
			nodeID = block.NodeID
		}
		next.Owner = &LaneOwner{
			NodeID:     nodeID,
			ActorID:    payloadString(block.Payload, "targetActorId"),
			LeaseEpoch: block.LeaseEpoch,
			LeaseUntil: payloadString(block.Payload, "leaseUntil"),
		}
	case "release":
		next.Owner = nil
	case "reconcile":
		if value := payloadString(block.Payload, "canonMarkdown"); value != "" {
			next.CanonMarkdown = value
		}
		if value := payloadString(block.Payload, "inventoryMarkdown"); value != "" {
			next.InventoryMarkdown = value
		}
	case "lane_snapshot":
		if value := payloadString(block.Payload, "canonMarkdown"); value != "" {
			next.CanonMarkdown = value
		}
		if value := payloadString(block.Payload, "inventoryMarkdown"); value != "" {
			next.InventoryMarkdown = value
		}
		if checkpoint, ok := snapshotCheckpoint(block.Payload); ok {
			next.Checkpoint = &checkpoint
		}
		if owner, ok := snapshotOwner(block.Payload); ok {
			next.Owner = &owner
		}
		next.Heads = []string{block.BlockID}
	}
	return next
}

func LaneActionForActor(lane LaneProjection, actor ActorRef, now string) TransitionAction {
	if lane.Owner == nil {
		return ActionContinue
	}
	if sameActor(*lane.Owner, actor) {
		return ActionContinue
	}
	if ownerLeaseExpired(*lane.Owner, now) {
		return ActionContinue
	}
	return ActionPause
}

func validateBootstrap(block TaskBlock, current *LaneProjection) TransitionResult {
	if current != nil && current.Tip != "" {
		return reject(ActionReconcile, "lane_exists", "bootstrap is only valid for an empty lane")
	}
	if block.LeaseEpoch != 0 {
		return reject(ActionReconcile, "stale_lease_epoch", "bootstrap leaseEpoch must be 0")
	}
	return validateParentTips(block, nil)
}

func validateClaim(block TaskBlock, ctx TransitionContext) TransitionResult {
	if result := validateParentTips(block, ctx.Current); !result.OK {
		return result
	}
	current := ctx.Current
	if current == nil || current.Tip == "" || current.Owner == nil {
		expected := int64(1)
		if current != nil {
			expected = current.LeaseEpoch + 1
		}
		if block.LeaseEpoch != expected {
			return reject(ActionReconcile, "stale_lease_epoch", fmt.Sprintf("claim_lane leaseEpoch must be %d", expected))
		}
		return accept()
	}
	if sameActor(*current.Owner, ActorRef{NodeID: block.NodeID, ActorID: block.ActorID}) {
		if block.LeaseEpoch != current.LeaseEpoch {
			return reject(ActionReconcile, "stale_lease_epoch", fmt.Sprintf("current owner must keep leaseEpoch %d", current.LeaseEpoch))
		}
		return accept()
	}
	if !ownerLeaseExpired(*current.Owner, ctx.Now) {
		return reject(ActionPause, "owner_active", fmt.Sprintf("lane is owned by %s/%s", current.Owner.NodeID, current.Owner.ActorID))
	}
	expected := current.LeaseEpoch + 1
	if block.LeaseEpoch != expected {
		return reject(ActionReconcile, "stale_lease_epoch", fmt.Sprintf("takeover claim leaseEpoch must be %d", expected))
	}
	return accept()
}

func validateOwnedTipBlock(block TaskBlock, current *LaneProjection, kind string) TransitionResult {
	if result := validateTipExtendingBlock(block, current, kind); !result.OK {
		return result
	}
	if current == nil || current.Owner == nil {
		return reject(ActionPause, "lane_missing", kind+" requires an active lane owner")
	}
	if !sameActor(*current.Owner, ActorRef{NodeID: block.NodeID, ActorID: block.ActorID}) {
		return reject(ActionPause, "not_lane_owner", kind+" signer is not the current lane owner")
	}
	if block.LeaseEpoch != current.LeaseEpoch {
		return reject(ActionReconcile, "stale_lease_epoch", fmt.Sprintf("%s leaseEpoch %d does not match current epoch %d", kind, block.LeaseEpoch, current.LeaseEpoch))
	}
	return accept()
}

func validateTipExtendingBlock(block TaskBlock, current *LaneProjection, kind string) TransitionResult {
	if current == nil || current.Tip == "" {
		return reject(ActionReconcile, "lane_missing", kind+" requires an existing lane tip")
	}
	if containsString(currentHeads(current), block.BlockID) {
		return reject(ActionContinue, "duplicate_tip", kind+" block is already a current head")
	}
	return validateCurrentHeadParentTips(block, current)
}

func validateLaneSnapshot(block TaskBlock, current *LaneProjection) TransitionResult {
	if current == nil || current.Tip == "" {
		return accept()
	}
	if result := validateCurrentHeadParentTips(block, current); !result.OK {
		return result
	}
	if current.Owner != nil && !sameActor(*current.Owner, ActorRef{NodeID: block.NodeID, ActorID: block.ActorID}) {
		return reject(ActionPause, "not_lane_owner", "lane_snapshot signer is not the current lane owner")
	}
	if block.LeaseEpoch != current.LeaseEpoch {
		return reject(ActionReconcile, "stale_lease_epoch", fmt.Sprintf("lane_snapshot leaseEpoch %d does not match current epoch %d", block.LeaseEpoch, current.LeaseEpoch))
	}
	return accept()
}

func snapshotCheckpoint(payload map[string]any) (CheckpointProjection, bool) {
	value, ok := payload["checkpoint"].(map[string]any)
	if !ok {
		return CheckpointProjection{}, false
	}
	return CheckpointProjection{
		Status:   payloadString(value, "status"),
		Progress: payloadString(value, "progress"),
		Files:    payloadString(value, "files"),
		Blocking: payloadString(value, "blocking"),
		Next:     payloadString(value, "next"),
	}, true
}

func snapshotOwner(payload map[string]any) (LaneOwner, bool) {
	value, ok := payload["owner"].(map[string]any)
	if !ok {
		return LaneOwner{}, false
	}
	leaseEpoch := int64(0)
	switch number := value["leaseEpoch"].(type) {
	case float64:
		leaseEpoch = int64(number)
	case int:
		leaseEpoch = int64(number)
	case int64:
		leaseEpoch = number
	}
	return LaneOwner{
		NodeID:     payloadString(value, "nodeId"),
		ActorID:    payloadString(value, "actorId"),
		LeaseEpoch: leaseEpoch,
		LeaseUntil: payloadString(value, "leaseUntil"),
	}, true
}

func validateReconcile(block TaskBlock, ctx TransitionContext) TransitionResult {
	if result := validateTipExtendingBlock(block, ctx.Current, "reconcile"); !result.OK {
		return result
	}
	tips, _ := block.Payload["conflictingTips"].([]any)
	for _, tip := range tips {
		text, _ := tip.(string)
		if ctx.HasBlock == nil || !ctx.HasBlock(text) {
			return reject(ActionReconcile, "unknown_parent_tip", "reconcile references unknown tip "+text)
		}
	}
	return accept()
}

func validateParentTips(block TaskBlock, current *LaneProjection) TransitionResult {
	expected := ""
	if current != nil {
		expected = current.Tip
	}
	if expected == "" {
		if len(block.ParentTips) == 0 {
			return accept()
		}
		return reject(ActionReconcile, "stale_parent_tip", "parentTips must equal current tip <empty>")
	}
	if len(block.ParentTips) != 1 || block.ParentTips[0] != expected {
		return reject(ActionReconcile, "stale_parent_tip", "parentTips must equal current tip "+expected)
	}
	return accept()
}

func validateCurrentHeadParentTips(block TaskBlock, current *LaneProjection) TransitionResult {
	heads := currentHeads(current)
	if len(heads) == 0 {
		if len(block.ParentTips) == 0 {
			return accept()
		}
		return reject(ActionReconcile, "stale_parent_tip", "parentTips must equal current heads <empty>")
	}
	if len(block.ParentTips) == 0 {
		return reject(ActionReconcile, "stale_parent_tip", "parentTips must include a current head: "+strings.Join(heads, ", "))
	}
	for _, tip := range block.ParentTips {
		if !containsString(heads, tip) {
			return reject(ActionReconcile, "stale_parent_tip", "parentTips must reference current heads: "+strings.Join(heads, ", "))
		}
	}
	return accept()
}

func validateSchedulerBlock(block TaskBlock, current *LaneProjection, kind string) TransitionResult {
	if current == nil || current.Tip == "" {
		return reject(ActionReconcile, "lane_missing", kind+" requires an existing lane tip")
	}
	if containsString(currentHeads(current), block.BlockID) {
		return reject(ActionContinue, "duplicate_tip", kind+" block is already a current head")
	}
	if len(block.ParentTips) == 0 {
		return reject(ActionReconcile, "stale_parent_tip", kind+" requires at least one known parent tip")
	}
	return accept()
}

func currentHeads(current *LaneProjection) []string {
	if current == nil {
		return nil
	}
	if len(current.Heads) > 0 {
		return append([]string{}, current.Heads...)
	}
	if current.Tip != "" {
		return []string{current.Tip}
	}
	return nil
}

func nextHeads(current *LaneProjection, block TaskBlock) []string {
	parents := map[string]bool{}
	for _, tip := range block.ParentTips {
		parents[tip] = true
	}
	next := make([]string, 0, len(currentHeads(current))+1)
	seen := map[string]bool{}
	for _, tip := range currentHeads(current) {
		if parents[tip] || seen[tip] {
			continue
		}
		next = append(next, tip)
		seen[tip] = true
	}
	if !seen[block.BlockID] {
		next = append(next, block.BlockID)
	}
	return next
}

func containsString(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}

func ownerLeaseExpired(owner LaneOwner, now string) bool {
	if owner.LeaseUntil == "" {
		return false
	}
	leaseUntil, err := time.Parse(time.RFC3339Nano, owner.LeaseUntil)
	if err != nil {
		return false
	}
	nowTime := time.Now().UTC()
	if now != "" {
		parsed, err := time.Parse(time.RFC3339Nano, now)
		if err == nil {
			nowTime = parsed
		}
	}
	return leaseUntil.Add(defaultLeaseGrace).Before(nowTime)
}

func sameLane(left LaneRef, right LaneRef) bool {
	return left.ProjectID == right.ProjectID && left.TaskID == right.TaskID && left.LaneID == right.LaneID
}

func sameActor(left LaneOwner, right ActorRef) bool {
	return left.NodeID == right.NodeID && left.ActorID == right.ActorID
}

func accept() TransitionResult {
	return TransitionResult{OK: true, Action: ActionContinue}
}

func reject(action TransitionAction, code string, message string) TransitionResult {
	return TransitionResult{OK: false, Action: action, Rejection: &Rejection{Code: code, Message: message}}
}
