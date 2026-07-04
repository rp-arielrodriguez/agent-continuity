package continuityd

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
)

func HashJSON(value any) (string, error) {
	bytes, err := CanonicalJSON(value)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(bytes)
	return "sha256:" + hex.EncodeToString(sum[:]), nil
}

func BlockIDFor(block TaskBlock) (string, error) {
	value, err := blockMap(block)
	if err != nil {
		return "", err
	}
	delete(value, "blockId")
	bytes, err := CanonicalJSON(value)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(bytes)
	return "blk_" + hex.EncodeToString(sum[:]), nil
}

func VerifyBlockSignature(block TaskBlock) bool {
	if block.Signature.Scheme != SignatureScheme || block.Signature.PublicKey == "" || block.Signature.Value == "" {
		return false
	}
	publicDER, err := base64.RawURLEncoding.DecodeString(block.Signature.PublicKey)
	if err != nil {
		return false
	}
	parsed, err := x509.ParsePKIXPublicKey(publicDER)
	if err != nil {
		return false
	}
	publicKey, ok := parsed.(ed25519.PublicKey)
	if !ok {
		return false
	}
	signature, err := base64.RawURLEncoding.DecodeString(block.Signature.Value)
	if err != nil {
		return false
	}
	unsigned, err := unsignedMap(block)
	if err != nil {
		return false
	}
	bytes, err := CanonicalJSON(unsigned)
	if err != nil {
		return false
	}
	return ed25519.Verify(publicKey, bytes, signature)
}

func CanonicalJSON(value any) ([]byte, error) {
	raw, err := marshalJSON(value)
	if err != nil {
		return nil, err
	}
	var normalized any
	if err := json.Unmarshal(raw, &normalized); err != nil {
		return nil, err
	}
	return marshalJSON(normalized)
}

func marshalJSON(value any) ([]byte, error) {
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		return nil, err
	}
	return bytes.TrimSuffix(buffer.Bytes(), []byte("\n")), nil
}

func blockMap(block TaskBlock) (map[string]any, error) {
	raw, err := json.Marshal(block)
	if err != nil {
		return nil, err
	}
	var value map[string]any
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil, err
	}
	return value, nil
}

func unsignedMap(block TaskBlock) (map[string]any, error) {
	value, err := blockMap(block)
	if err != nil {
		return nil, err
	}
	delete(value, "blockId")
	delete(value, "signature")
	value["signerPublicKey"] = block.Signature.PublicKey
	return value, nil
}

func ValidateTaskBlock(block TaskBlock) []Rejection {
	var issues []Rejection
	if block.Version != TaskBlockVersion {
		issues = appendIssue(issues, "invalid_version", fmt.Sprintf("unsupported task block version %d", block.Version))
	}
	for field, value := range map[string]string{
		"blockId":   block.BlockID,
		"projectId": block.ProjectID,
		"taskId":    block.TaskID,
		"laneId":    block.LaneID,
		"nodeId":    block.NodeID,
		"actorId":   block.ActorID,
	} {
		if !validIdentifier(value) {
			issues = appendIssue(issues, "invalid_identifier", field+" must be a non-empty continuity identifier")
		}
	}
	if block.LeaseEpoch < 0 {
		issues = appendIssue(issues, "invalid_lease_epoch", "leaseEpoch must be non-negative")
	}
	if !validTimestamp(block.CreatedAt) {
		issues = appendIssue(issues, "invalid_created_at", "createdAt must be an ISO timestamp")
	}
	for _, tip := range block.ParentTips {
		if !validBlockID(tip) {
			issues = appendIssue(issues, "invalid_parent_tips", "parentTips must contain valid block ids")
			break
		}
	}
	issues = append(issues, validatePayload(block.Kind, block.Payload)...)
	payloadHash, err := HashJSON(block.Payload)
	if err != nil || payloadHash != block.PayloadHash {
		issues = appendIssue(issues, "invalid_payload_hash", "payloadHash does not match canonical payload")
	}
	blockID, err := BlockIDFor(block)
	if err != nil || blockID != block.BlockID {
		issues = appendIssue(issues, "invalid_block_id", "blockId does not match canonical signed block")
	}
	if !VerifyBlockSignature(block) {
		issues = appendIssue(issues, "invalid_signature", "signature does not verify canonical unsigned block content")
	}
	return issues
}

func payloadString(payload map[string]any, field string) string {
	value, _ := payload[field].(string)
	return value
}

func requiredPayloadString(payload map[string]any, field string) error {
	if payloadString(payload, field) == "" {
		return errors.New(field + " must be a non-empty string")
	}
	return nil
}

func validatePayload(kind string, payload map[string]any) []Rejection {
	var issues []Rejection
	switch kind {
	case "bootstrap":
		if err := requiredPayloadString(payload, "summary"); err != nil {
			issues = appendIssue(issues, "invalid_kind_payload", err.Error())
		}
	case "claim_lane":
		if value := payloadString(payload, "leaseUntil"); value != "" && !validTimestamp(value) {
			issues = appendIssue(issues, "invalid_kind_payload", "leaseUntil must be an ISO timestamp when provided")
		}
	case "heartbeat":
		if value := payloadString(payload, "leaseUntil"); value == "" || !validTimestamp(value) {
			issues = appendIssue(issues, "invalid_kind_payload", "leaseUntil must be an ISO timestamp")
		}
	case "checkpoint":
		if err := requiredPayloadString(payload, "status"); err != nil {
			issues = appendIssue(issues, "invalid_kind_payload", err.Error())
		}
		if !validCheckpointStatus(payloadString(payload, "status")) {
			issues = appendIssue(issues, "invalid_kind_payload", "status must be a known checkpoint status")
		}
		if err := requiredPayloadString(payload, "progress"); err != nil {
			issues = appendIssue(issues, "invalid_kind_payload", err.Error())
		}
	case "canon_update":
		if err := requiredPayloadString(payload, "canonMarkdown"); err != nil {
			issues = appendIssue(issues, "invalid_kind_payload", err.Error())
		}
	case "inventory_update":
		if err := requiredPayloadString(payload, "inventoryMarkdown"); err != nil {
			issues = appendIssue(issues, "invalid_kind_payload", err.Error())
		}
	case "handoff":
		if err := requiredPayloadString(payload, "targetActorId"); err != nil {
			issues = appendIssue(issues, "invalid_kind_payload", err.Error())
		}
		if value := payloadString(payload, "leaseUntil"); value != "" && !validTimestamp(value) {
			issues = appendIssue(issues, "invalid_kind_payload", "leaseUntil must be an ISO timestamp when provided")
		}
	case "release":
	case "pause":
		if err := requiredPayloadString(payload, "reason"); err != nil {
			issues = appendIssue(issues, "invalid_kind_payload", err.Error())
		}
	case "reconcile":
		if err := requiredPayloadString(payload, "summary"); err != nil {
			issues = appendIssue(issues, "invalid_kind_payload", err.Error())
		}
		tips, ok := payload["conflictingTips"].([]any)
		if !ok {
			issues = appendIssue(issues, "invalid_kind_payload", "conflictingTips must be an array")
			break
		}
		for _, tip := range tips {
			text, ok := tip.(string)
			if !ok || !validBlockID(text) {
				issues = appendIssue(issues, "invalid_kind_payload", "conflictingTips must contain valid block ids")
				break
			}
		}
	default:
		issues = appendIssue(issues, "invalid_kind_payload", "unsupported task block kind "+kind)
	}
	return issues
}
