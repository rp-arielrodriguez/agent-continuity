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

func payloadStringSlice(payload map[string]any, field string) ([]string, bool) {
	value, ok := payload[field]
	if !ok {
		return nil, false
	}
	entries, ok := value.([]any)
	if !ok {
		return nil, true
	}
	output := make([]string, 0, len(entries))
	for _, entry := range entries {
		text, ok := entry.(string)
		if !ok || text == "" {
			return nil, true
		}
		output = append(output, text)
	}
	return output, false
}

func optionalPayloadStringSlice(payload map[string]any, field string) error {
	_, invalid := payloadStringSlice(payload, field)
	if invalid {
		return errors.New(field + " must contain non-empty strings when provided")
	}
	return nil
}

func optionalPayloadInteger(payload map[string]any, field string) error {
	if _, exists := payload[field]; !exists {
		return nil
	}
	if _, ok := payloadIntegerValue(payload, field); !ok {
		return errors.New(field + " must be an integer when provided")
	}
	return nil
}

func optionalPayloadNumber(payload map[string]any, field string) error {
	value, ok := payload[field]
	if !ok {
		return nil
	}
	number, ok := value.(float64)
	if !ok {
		if number, ok := value.(int); ok {
			if number < 0 {
				return errors.New(field + " must be a non-negative number when provided")
			}
			return nil
		}
		if number, ok := value.(int64); ok {
			if number < 0 {
				return errors.New(field + " must be a non-negative number when provided")
			}
			return nil
		}
		return errors.New(field + " must be a non-negative number when provided")
	}
	if number < 0 {
		return errors.New(field + " must be a non-negative number when provided")
	}
	return nil
}

func optionalPayloadBool(payload map[string]any, field string) error {
	value, ok := payload[field]
	if !ok {
		return nil
	}
	if _, ok := value.(bool); !ok {
		return errors.New(field + " must be a boolean when provided")
	}
	return nil
}

func requiredPayloadBlockID(payload map[string]any, field string) error {
	value := payloadString(payload, field)
	if !validBlockID(value) {
		return errors.New(field + " must be a valid block id")
	}
	return nil
}

func requiredPayloadBlockIDSlice(payload map[string]any, field string) ([]string, error) {
	values, ok := payload[field].([]any)
	if !ok || len(values) == 0 {
		return nil, errors.New(field + " must be a non-empty array")
	}
	output := make([]string, 0, len(values))
	for _, value := range values {
		text, ok := value.(string)
		if !ok || !validBlockID(text) {
			return nil, errors.New(field + " must contain valid block ids")
		}
		output = append(output, text)
	}
	return output, nil
}

func optionalPayloadBlockID(payload map[string]any, field string) error {
	value, ok := payload[field]
	if !ok {
		return nil
	}
	text, ok := value.(string)
	if !ok || !validBlockID(text) {
		return errors.New(field + " must be a valid block id when provided")
	}
	return nil
}

func optionalPayloadTimestamp(payload map[string]any, field string) error {
	value := payloadString(payload, field)
	if value != "" && !validTimestamp(value) {
		return errors.New(field + " must be an ISO timestamp when provided")
	}
	return nil
}

func optionalTaskRequirements(payload map[string]any) error {
	value, ok := payload["requirements"]
	if !ok {
		return nil
	}
	requirements, ok := value.(map[string]any)
	if !ok {
		return errors.New("requirements must be an object when provided")
	}
	for _, field := range []string{"agents", "modelFamilies", "models", "tools"} {
		if err := optionalPayloadStringSlice(requirements, field); err != nil {
			return err
		}
	}
	return nil
}

func optionalEvaluationSpec(payload map[string]any) error {
	value, ok := payload["evaluation"]
	if !ok {
		return nil
	}
	evaluation, ok := value.(map[string]any)
	if !ok {
		return errors.New("evaluation must be an object when provided")
	}
	if mode := payloadString(evaluation, "mode"); mode != "" && !validEvaluationMode(mode) {
		return errors.New("evaluation.mode must be one of manual, agent, deterministic")
	}
	if confidence := payloadString(evaluation, "confidenceThreshold"); confidence != "" && !validEvaluationConfidence(confidence) {
		return errors.New("evaluation.confidenceThreshold must be one of low, medium, high")
	}
	if err := optionalPayloadBool(evaluation, "autoAdjudicate"); err != nil {
		return errors.New("evaluation." + err.Error())
	}
	if err := optionalPayloadStringSlice(evaluation, "requiredChecks"); err != nil {
		return errors.New("evaluation." + err.Error())
	}
	if err := optionalEvaluationRubric(evaluation); err != nil {
		return err
	}
	if err := optionalEvaluationUseCases(evaluation); err != nil {
		return err
	}
	return nil
}

func optionalEvaluationRubric(payload map[string]any) error {
	values, ok := payload["rubric"]
	if !ok {
		return nil
	}
	entries, ok := values.([]any)
	if !ok {
		return errors.New("evaluation.rubric must be an array when provided")
	}
	for index, entry := range entries {
		item, ok := entry.(map[string]any)
		if !ok {
			return fmt.Errorf("evaluation.rubric[%d] must be an object", index)
		}
		if err := requiredPayloadString(item, "name"); err != nil {
			return fmt.Errorf("evaluation.rubric[%d].%w", index, err)
		}
		if err := optionalPayloadNumber(item, "weight"); err != nil {
			return fmt.Errorf("evaluation.rubric[%d].%w", index, err)
		}
		if value, ok := item["description"]; ok {
			if _, ok := value.(string); !ok {
				return fmt.Errorf("evaluation.rubric[%d].description must be a string when provided", index)
			}
		}
	}
	return nil
}

func optionalEvaluationUseCases(payload map[string]any) error {
	values, ok := payload["useCases"]
	if !ok {
		return nil
	}
	entries, ok := values.([]any)
	if !ok {
		return errors.New("evaluation.useCases must be an array when provided")
	}
	for index, entry := range entries {
		useCase, ok := entry.(map[string]any)
		if !ok {
			return fmt.Errorf("evaluation.useCases[%d] must be an object", index)
		}
		if err := requiredPayloadString(useCase, "id"); err != nil {
			return fmt.Errorf("evaluation.useCases[%d].%w", index, err)
		}
		if err := requiredPayloadString(useCase, "title"); err != nil {
			return fmt.Errorf("evaluation.useCases[%d].%w", index, err)
		}
		if err := optionalPayloadBool(useCase, "mustPass"); err != nil {
			return fmt.Errorf("evaluation.useCases[%d].%w", index, err)
		}
		if err := optionalPayloadStringSlice(useCase, "evidence"); err != nil {
			return fmt.Errorf("evaluation.useCases[%d].%w", index, err)
		}
	}
	return nil
}

func optionalEvaluationScores(payload map[string]any, candidateBlockIDs []string) error {
	values, ok := payload["scores"]
	if !ok {
		return nil
	}
	entries, ok := values.([]any)
	if !ok {
		return errors.New("scores must be an array when provided")
	}
	for index, entry := range entries {
		score, ok := entry.(map[string]any)
		if !ok {
			return fmt.Errorf("scores[%d] must be an object", index)
		}
		if err := requiredPayloadBlockID(score, "resultBlockId"); err != nil {
			return fmt.Errorf("scores[%d].%w", index, err)
		}
		if resultBlockID := payloadString(score, "resultBlockId"); len(candidateBlockIDs) > 0 && !containsString(candidateBlockIDs, resultBlockID) {
			return fmt.Errorf("scores[%d].resultBlockId must be one of resultBlockIds", index)
		}
		if err := optionalPayloadNumber(score, "totalScore"); err != nil {
			return fmt.Errorf("scores[%d].%w", index, err)
		}
		if err := optionalEvaluationCriteria(score, index); err != nil {
			return err
		}
	}
	return nil
}

func optionalEvaluationCriteria(score map[string]any, scoreIndex int) error {
	values, ok := score["criteria"]
	if !ok {
		return nil
	}
	entries, ok := values.([]any)
	if !ok {
		return fmt.Errorf("scores[%d].criteria must be an array when provided", scoreIndex)
	}
	for index, entry := range entries {
		criterion, ok := entry.(map[string]any)
		if !ok {
			return fmt.Errorf("scores[%d].criteria[%d] must be an object", scoreIndex, index)
		}
		if err := requiredPayloadString(criterion, "name"); err != nil {
			return fmt.Errorf("scores[%d].criteria[%d].%w", scoreIndex, index, err)
		}
		if err := optionalPayloadNumber(criterion, "score"); err != nil {
			return fmt.Errorf("scores[%d].criteria[%d].%w", scoreIndex, index, err)
		}
		if value, ok := criterion["rationale"]; ok {
			if _, ok := value.(string); !ok {
				return fmt.Errorf("scores[%d].criteria[%d].rationale must be a string when provided", scoreIndex, index)
			}
		}
	}
	return nil
}

func optionalEvaluationChecks(payload map[string]any, field string) error {
	values, ok := payload[field]
	if !ok {
		return nil
	}
	entries, ok := values.([]any)
	if !ok {
		return errors.New(field + " must be an array when provided")
	}
	for index, entry := range entries {
		check, ok := entry.(map[string]any)
		if !ok {
			return fmt.Errorf("%s[%d] must be an object", field, index)
		}
		if err := requiredPayloadString(check, "name"); err != nil {
			return fmt.Errorf("%s[%d].%w", field, index, err)
		}
		value, ok := check["passed"]
		if !ok {
			return fmt.Errorf("%s[%d].passed must be a boolean", field, index)
		}
		if _, ok := value.(bool); !ok {
			return fmt.Errorf("%s[%d].passed must be a boolean", field, index)
		}
		if err := optionalPayloadStringSlice(check, "evidence"); err != nil {
			return fmt.Errorf("%s[%d].%w", field, index, err)
		}
	}
	return nil
}

func optionalEvaluationUseCaseResults(payload map[string]any) error {
	values, ok := payload["useCases"]
	if !ok {
		return nil
	}
	entries, ok := values.([]any)
	if !ok {
		return errors.New("useCases must be an array when provided")
	}
	for index, entry := range entries {
		useCase, ok := entry.(map[string]any)
		if !ok {
			return fmt.Errorf("useCases[%d] must be an object", index)
		}
		if err := requiredPayloadString(useCase, "id"); err != nil {
			return fmt.Errorf("useCases[%d].%w", index, err)
		}
		value, ok := useCase["passed"]
		if !ok {
			return fmt.Errorf("useCases[%d].passed must be a boolean", index)
		}
		if _, ok := value.(bool); !ok {
			return fmt.Errorf("useCases[%d].passed must be a boolean", index)
		}
		if err := optionalPayloadStringSlice(useCase, "evidence"); err != nil {
			return fmt.Errorf("useCases[%d].%w", index, err)
		}
		if value, ok := useCase["notes"]; ok {
			if _, ok := value.(string); !ok {
				return fmt.Errorf("useCases[%d].notes must be a string when provided", index)
			}
		}
	}
	return nil
}

func optionalCheckpointProjection(payload map[string]any) error {
	value, ok := payload["checkpoint"]
	if !ok {
		return nil
	}
	checkpoint, ok := value.(map[string]any)
	if !ok {
		return errors.New("checkpoint must be an object when provided")
	}
	if err := requiredPayloadString(checkpoint, "status"); err != nil {
		return err
	}
	if !validCheckpointStatus(payloadString(checkpoint, "status")) {
		return errors.New("checkpoint.status must be a known checkpoint status")
	}
	if err := requiredPayloadString(checkpoint, "progress"); err != nil {
		return err
	}
	for _, field := range []string{"files", "blocking", "next"} {
		if value, ok := checkpoint[field]; ok {
			if _, ok := value.(string); !ok {
				return errors.New("checkpoint." + field + " must be a string when provided")
			}
		}
	}
	return nil
}

func optionalSnapshotOwner(payload map[string]any) error {
	value, ok := payload["owner"]
	if !ok {
		return nil
	}
	owner, ok := value.(map[string]any)
	if !ok {
		return errors.New("owner must be an object when provided")
	}
	if err := requiredPayloadString(owner, "nodeId"); err != nil {
		return errors.New("owner." + err.Error())
	}
	if err := requiredPayloadString(owner, "actorId"); err != nil {
		return errors.New("owner." + err.Error())
	}
	leaseEpoch, ok := payloadIntegerValue(owner, "leaseEpoch")
	if !ok || leaseEpoch < 0 {
		return errors.New("owner.leaseEpoch must be a non-negative integer")
	}
	if err := optionalPayloadTimestamp(owner, "leaseUntil"); err != nil {
		return errors.New("owner." + err.Error())
	}
	return nil
}

func payloadIntegerValue(payload map[string]any, field string) (int64, bool) {
	value, ok := payload[field]
	if !ok {
		return 0, false
	}
	switch number := value.(type) {
	case float64:
		if number != float64(int64(number)) {
			return 0, false
		}
		return int64(number), true
	case int:
		return int64(number), true
	case int64:
		return number, true
	default:
		return 0, false
	}
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
	case "lane_snapshot":
		if err := requiredPayloadString(payload, "summary"); err != nil {
			issues = appendIssue(issues, "invalid_kind_payload", err.Error())
		}
		values, ok := payload["baseBlockIds"].([]any)
		if !ok || len(values) == 0 {
			issues = appendIssue(issues, "invalid_kind_payload", "baseBlockIds must be a non-empty array")
		} else {
			for _, value := range values {
				text, ok := value.(string)
				if !ok || !validBlockID(text) {
					issues = appendIssue(issues, "invalid_kind_payload", "baseBlockIds must contain valid block ids")
					break
				}
			}
		}
		if err := optionalPayloadInteger(payload, "compactedBlockCount"); err != nil {
			issues = appendIssue(issues, "invalid_kind_payload", err.Error())
		}
		if err := optionalCheckpointProjection(payload); err != nil {
			issues = appendIssue(issues, "invalid_kind_payload", err.Error())
		}
		if err := optionalSnapshotOwner(payload); err != nil {
			issues = appendIssue(issues, "invalid_kind_payload", err.Error())
		}
	case "task_intent":
		if err := requiredPayloadString(payload, "title"); err != nil {
			issues = appendIssue(issues, "invalid_kind_payload", err.Error())
		}
		if err := requiredPayloadString(payload, "instructions"); err != nil {
			issues = appendIssue(issues, "invalid_kind_payload", err.Error())
		}
		if policy := payloadString(payload, "policy"); policy != "" && !validTaskPolicy(policy) {
			issues = appendIssue(issues, "invalid_kind_payload", "policy must be one of exclusive, speculative")
		}
		if err := optionalPayloadInteger(payload, "priority"); err != nil {
			issues = appendIssue(issues, "invalid_kind_payload", err.Error())
		}
		if err := optionalTaskRequirements(payload); err != nil {
			issues = appendIssue(issues, "invalid_kind_payload", err.Error())
		}
		if err := optionalEvaluationSpec(payload); err != nil {
			issues = appendIssue(issues, "invalid_kind_payload", err.Error())
		}
	case "worker_profile":
		if err := requiredPayloadString(payload, "workerId"); err != nil {
			issues = appendIssue(issues, "invalid_kind_payload", err.Error())
		}
		if err := requiredPayloadString(payload, "agent"); err != nil {
			issues = appendIssue(issues, "invalid_kind_payload", err.Error())
		}
		for _, field := range []string{"modelFamilies", "models", "tools"} {
			if err := optionalPayloadStringSlice(payload, field); err != nil {
				issues = appendIssue(issues, "invalid_kind_payload", err.Error())
			}
		}
		if err := optionalPayloadInteger(payload, "maxConcurrent"); err != nil {
			issues = appendIssue(issues, "invalid_kind_payload", err.Error())
		}
		if err := optionalPayloadBool(payload, "enabled"); err != nil {
			issues = appendIssue(issues, "invalid_kind_payload", err.Error())
		}
	case "task_assignment":
		if err := requiredPayloadBlockID(payload, "intentBlockId"); err != nil {
			issues = appendIssue(issues, "invalid_kind_payload", err.Error())
		}
		if err := requiredPayloadString(payload, "workerId"); err != nil {
			issues = appendIssue(issues, "invalid_kind_payload", err.Error())
		}
		if err := requiredPayloadString(payload, "assignedLaneId"); err != nil {
			issues = appendIssue(issues, "invalid_kind_payload", err.Error())
		}
		if mode := payloadString(payload, "mode"); mode != "" && !validTaskAssignmentMode(mode) {
			issues = appendIssue(issues, "invalid_kind_payload", "mode must be one of manual, automatic")
		}
		if err := optionalPayloadTimestamp(payload, "leaseUntil"); err != nil {
			issues = appendIssue(issues, "invalid_kind_payload", err.Error())
		}
	case "task_result":
		if err := requiredPayloadBlockID(payload, "intentBlockId"); err != nil {
			issues = appendIssue(issues, "invalid_kind_payload", err.Error())
		}
		if err := optionalPayloadBlockID(payload, "assignmentBlockId"); err != nil {
			issues = appendIssue(issues, "invalid_kind_payload", err.Error())
		}
		if err := requiredPayloadString(payload, "workerId"); err != nil {
			issues = appendIssue(issues, "invalid_kind_payload", err.Error())
		}
		if err := requiredPayloadString(payload, "status"); err != nil {
			issues = appendIssue(issues, "invalid_kind_payload", err.Error())
		}
		if status := payloadString(payload, "status"); status != "" && !validTaskResultStatus(status) {
			issues = appendIssue(issues, "invalid_kind_payload", "status must be a known task result status")
		}
		if err := requiredPayloadString(payload, "summary"); err != nil {
			issues = appendIssue(issues, "invalid_kind_payload", err.Error())
		}
		if err := optionalPayloadStringSlice(payload, "artifacts"); err != nil {
			issues = appendIssue(issues, "invalid_kind_payload", err.Error())
		}
		if err := optionalPayloadInteger(payload, "exitCode"); err != nil {
			issues = appendIssue(issues, "invalid_kind_payload", err.Error())
		}
		for _, field := range []string{"startedAt", "completedAt"} {
			if err := optionalPayloadTimestamp(payload, field); err != nil {
				issues = appendIssue(issues, "invalid_kind_payload", err.Error())
			}
		}
	case "task_evaluation":
		if err := requiredPayloadBlockID(payload, "intentBlockId"); err != nil {
			issues = appendIssue(issues, "invalid_kind_payload", err.Error())
		}
		resultBlockIDs, err := requiredPayloadBlockIDSlice(payload, "resultBlockIds")
		if err != nil {
			issues = appendIssue(issues, "invalid_kind_payload", err.Error())
		}
		recommended := payloadString(payload, "recommendedWinnerResultBlockId")
		if recommended != "" {
			if !validBlockID(recommended) {
				issues = appendIssue(issues, "invalid_kind_payload", "recommendedWinnerResultBlockId must be a valid block id when provided")
			} else if len(resultBlockIDs) > 0 && !containsString(resultBlockIDs, recommended) {
				issues = appendIssue(issues, "invalid_kind_payload", "recommendedWinnerResultBlockId must be one of resultBlockIds")
			}
		}
		if confidence := payloadString(payload, "confidence"); confidence != "" && !validEvaluationConfidence(confidence) {
			issues = appendIssue(issues, "invalid_kind_payload", "confidence must be one of low, medium, high")
		}
		if err := optionalEvaluationScores(payload, resultBlockIDs); err != nil {
			issues = appendIssue(issues, "invalid_kind_payload", err.Error())
		}
		if err := optionalEvaluationChecks(payload, "requiredChecks"); err != nil {
			issues = appendIssue(issues, "invalid_kind_payload", err.Error())
		}
		if err := optionalEvaluationUseCaseResults(payload); err != nil {
			issues = appendIssue(issues, "invalid_kind_payload", err.Error())
		}
		if err := optionalPayloadStringSlice(payload, "risks"); err != nil {
			issues = appendIssue(issues, "invalid_kind_payload", err.Error())
		}
		if err := optionalPayloadBool(payload, "autoAdjudicateEligible"); err != nil {
			issues = appendIssue(issues, "invalid_kind_payload", err.Error())
		}
		if err := requiredPayloadString(payload, "summary"); err != nil {
			issues = appendIssue(issues, "invalid_kind_payload", err.Error())
		}
	case "task_adjudication":
		if err := requiredPayloadBlockID(payload, "intentBlockId"); err != nil {
			issues = appendIssue(issues, "invalid_kind_payload", err.Error())
		}
		values, ok := payload["resultBlockIds"].([]any)
		if !ok || len(values) == 0 {
			issues = appendIssue(issues, "invalid_kind_payload", "resultBlockIds must be a non-empty array")
		} else {
			for _, value := range values {
				text, ok := value.(string)
				if !ok || !validBlockID(text) {
					issues = appendIssue(issues, "invalid_kind_payload", "resultBlockIds must contain valid block ids")
					break
				}
			}
		}
		if err := optionalPayloadBlockID(payload, "winnerResultBlockId"); err != nil {
			issues = appendIssue(issues, "invalid_kind_payload", err.Error())
		}
		if err := requiredPayloadString(payload, "summary"); err != nil {
			issues = appendIssue(issues, "invalid_kind_payload", err.Error())
		}
	default:
		issues = appendIssue(issues, "invalid_kind_payload", "unsupported task block kind "+kind)
	}
	return issues
}
