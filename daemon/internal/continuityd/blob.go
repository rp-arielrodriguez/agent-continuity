package continuityd

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"time"
)

const (
	blobInlineThresholdBytes = 2048
	blobRefMarker            = "continuity-blob-ref-v1"
)

type blobRef struct {
	Marker    string `json:"__continuityBlobRef"`
	Digest    string `json:"digest"`
	SizeBytes int    `json:"sizeBytes"`
	Encoding  string `json:"encoding"`
}

type blobExecQuerier interface {
	ExecContext(context.Context, string, ...any) (sql.Result, error)
	QueryRowContext(context.Context, string, ...any) *sql.Row
}

func externalizeJSONValue(ctx context.Context, db blobExecQuerier, value any, now string) (any, error) {
	switch typed := value.(type) {
	case string:
		if len([]byte(typed)) <= blobInlineThresholdBytes {
			return typed, nil
		}
		digest := digestString(typed)
		if err := putBlob(ctx, db, digest, []byte(typed), now); err != nil {
			return nil, err
		}
		return map[string]any{
			"__continuityBlobRef": blobRefMarker,
			"digest":              digest,
			"sizeBytes":           len([]byte(typed)),
			"encoding":            "utf8",
		}, nil
	case []any:
		out := make([]any, 0, len(typed))
		for _, entry := range typed {
			next, err := externalizeJSONValue(ctx, db, entry, now)
			if err != nil {
				return nil, err
			}
			out = append(out, next)
		}
		return out, nil
	case map[string]any:
		out := make(map[string]any, len(typed))
		for key, entry := range typed {
			next, err := externalizeJSONValue(ctx, db, entry, now)
			if err != nil {
				return nil, err
			}
			out[key] = next
		}
		return out, nil
	default:
		return value, nil
	}
}

func hydrateJSONValue(ctx context.Context, db queryer, value any) (any, error) {
	switch typed := value.(type) {
	case []any:
		out := make([]any, 0, len(typed))
		for _, entry := range typed {
			next, err := hydrateJSONValue(ctx, db, entry)
			if err != nil {
				return nil, err
			}
			out = append(out, next)
		}
		return out, nil
	case map[string]any:
		if marker, _ := typed["__continuityBlobRef"].(string); marker == blobRefMarker {
			digest, _ := typed["digest"].(string)
			content, err := loadBlob(ctx, db, digest)
			if err != nil {
				return nil, err
			}
			return string(content), nil
		}
		out := make(map[string]any, len(typed))
		for key, entry := range typed {
			next, err := hydrateJSONValue(ctx, db, entry)
			if err != nil {
				return nil, err
			}
			out[key] = next
		}
		return out, nil
	default:
		return value, nil
	}
}

func decodeStoredBlock(ctx context.Context, db queryer, blockJSON string) (TaskBlock, error) {
	var raw any
	if err := json.Unmarshal([]byte(blockJSON), &raw); err != nil {
		return TaskBlock{}, fmt.Errorf("decode stored block json: %w", err)
	}
	hydrated, err := hydrateJSONValue(ctx, db, raw)
	if err != nil {
		return TaskBlock{}, err
	}
	bytes, err := json.Marshal(hydrated)
	if err != nil {
		return TaskBlock{}, err
	}
	var block TaskBlock
	if err := json.Unmarshal(bytes, &block); err != nil {
		return TaskBlock{}, fmt.Errorf("decode stored block: %w", err)
	}
	return block, nil
}

func putBlob(ctx context.Context, db blobExecQuerier, digest string, content []byte, now string) error {
	timestamp := timestampOrNow(now)
	_, err := db.ExecContext(ctx, `
      INSERT INTO blob_objects (digest, size_bytes, content, created_at, last_accessed_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(digest) DO UPDATE SET last_accessed_at = excluded.last_accessed_at`,
		digest,
		len(content),
		content,
		timestamp,
		timestamp,
	)
	if err != nil {
		return fmt.Errorf("store blob %s: %w", digest, err)
	}
	return nil
}

func loadBlob(ctx context.Context, db queryer, digest string) ([]byte, error) {
	if digest == "" {
		return nil, fmt.Errorf("blob digest is required")
	}
	var content []byte
	if err := db.QueryRowContext(ctx, `SELECT content FROM blob_objects WHERE digest = ?`, digest).Scan(&content); err != nil {
		if err == sql.ErrNoRows {
			return nil, fmt.Errorf("blob %s not found", digest)
		}
		return nil, fmt.Errorf("load blob %s: %w", digest, err)
	}
	if digestBytes(content) != digest {
		return nil, fmt.Errorf("blob %s failed digest verification", digest)
	}
	return content, nil
}

func (s *SQLiteStore) Blob(ctx context.Context, digest string) (BlobGetResult, error) {
	content, err := loadBlob(ctx, s.db, digest)
	if err != nil {
		return BlobGetResult{}, err
	}
	_, _ = s.db.ExecContext(ctx, `UPDATE blob_objects SET last_accessed_at = ? WHERE digest = ?`, time.Now().UTC().Format(time.RFC3339Nano), digest)
	return BlobGetResult{
		Digest:    digest,
		SizeBytes: len(content),
		Content:   base64.StdEncoding.EncodeToString(content),
	}, nil
}

func collectBlobDigests(value any) []string {
	seen := map[string]bool{}
	var out []string
	var walk func(any)
	walk = func(entry any) {
		switch typed := entry.(type) {
		case []any:
			for _, item := range typed {
				walk(item)
			}
		case map[string]any:
			if marker, _ := typed["__continuityBlobRef"].(string); marker == blobRefMarker {
				if digest, _ := typed["digest"].(string); digest != "" && !seen[digest] {
					seen[digest] = true
					out = append(out, digest)
				}
				return
			}
			for _, item := range typed {
				walk(item)
			}
		}
	}
	walk(value)
	return out
}

func storedBlockBlobDigests(blockJSON string) []string {
	var raw any
	if err := json.Unmarshal([]byte(blockJSON), &raw); err != nil {
		return nil
	}
	return collectBlobDigests(raw)
}

func digestString(value string) string {
	return digestBytes([]byte(value))
}

func digestBytes(value []byte) string {
	sum := sha256.Sum256(value)
	return "sha256:" + hex.EncodeToString(sum[:])
}
