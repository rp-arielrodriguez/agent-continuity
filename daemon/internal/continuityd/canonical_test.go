package continuityd

import (
	"strings"
	"testing"
)

func TestCanonicalJSONDoesNotHTMLEscapeStrings(t *testing.T) {
	bytes, err := CanonicalJSON(map[string]any{
		"text": "<!-- guard --> A & B",
	})
	if err != nil {
		t.Fatal(err)
	}
	text := string(bytes)
	if strings.Contains(text, `\u003c`) || strings.Contains(text, `\u003e`) || strings.Contains(text, `\u0026`) {
		t.Fatalf("canonical json escaped html characters: %s", text)
	}
	if text != `{"text":"<!-- guard --> A & B"}` {
		t.Fatalf("canonical json = %s", text)
	}
}
