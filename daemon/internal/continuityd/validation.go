package continuityd

import (
	"regexp"
	"time"
)

var (
	identifierRE = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,255}$`)
	blockIDRE    = regexp.MustCompile(`^blk_[a-f0-9]{64}$`)
)

func validIdentifier(value string) bool {
	return identifierRE.MatchString(value)
}

func validBlockID(value string) bool {
	return blockIDRE.MatchString(value)
}

func validTimestamp(value string) bool {
	if value == "" {
		return false
	}
	_, err := time.Parse(time.RFC3339Nano, value)
	return err == nil
}

func validCheckpointStatus(value string) bool {
	switch value {
	case "pending", "in_progress", "blocked", "completed", "cancelled":
		return true
	default:
		return false
	}
}

func validTaskPolicy(value string) bool {
	switch value {
	case "exclusive", "speculative":
		return true
	default:
		return false
	}
}

func validTaskAssignmentMode(value string) bool {
	switch value {
	case "manual", "automatic":
		return true
	default:
		return false
	}
}

func validTaskResultStatus(value string) bool {
	switch value {
	case "completed", "failed", "blocked", "cancelled":
		return true
	default:
		return false
	}
}

func validEvaluationMode(value string) bool {
	switch value {
	case "manual", "agent", "deterministic":
		return true
	default:
		return false
	}
}

func validEvaluationConfidence(value string) bool {
	switch value {
	case "low", "medium", "high":
		return true
	default:
		return false
	}
}

func appendIssue(issues []Rejection, code string, message string) []Rejection {
	return append(issues, Rejection{Code: code, Message: message})
}
