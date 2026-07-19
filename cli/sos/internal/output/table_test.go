// SPDX-License-Identifier: Apache-2.0
package output

import (
	"strings"
	"testing"
)

func TestTableEmpty(t *testing.T) {
	if got := Table([]string{"A"}, nil); got != "(no rows)\n" {
		t.Fatalf("empty table = %q", got)
	}
}

func TestTableAligns(t *testing.T) {
	out := Table([]string{"ID", "NAME"}, [][]string{
		{"1", "short"},
		{"1000", "a-longer-name"},
	})
	lines := strings.Split(strings.TrimRight(out, "\n"), "\n")
	if len(lines) != 4 { // header, separator, 2 rows
		t.Fatalf("expected 4 lines, got %d: %q", len(lines), out)
	}
	// Every line should be at least as wide as the header row's content columns.
	if !strings.Contains(lines[0], "ID") || !strings.Contains(lines[0], "NAME") {
		t.Fatalf("header missing columns: %q", lines[0])
	}
	if !strings.HasPrefix(lines[3], "1000") {
		t.Fatalf("widest id not left-aligned: %q", lines[3])
	}
}

func TestPrettyJSONReindents(t *testing.T) {
	got := PrettyJSON(`{"b":2,"a":1}`)
	if !strings.Contains(got, "\n") {
		t.Fatalf("expected multi-line JSON, got %q", got)
	}
}

func TestPrettyJSONPassesThroughNonJSON(t *testing.T) {
	if got := PrettyJSON("not json"); got != "not json" {
		t.Fatalf("non-JSON should pass through, got %q", got)
	}
}

func TestDatasetsTableTopLevelArray(t *testing.T) {
	raw := `[{"id":"ds1","name":"Orders","domain":"sales","tier":"Shared"}]`
	out, err := DatasetsTable(raw)
	if err != nil {
		t.Fatalf("DatasetsTable: %v", err)
	}
	for _, want := range []string{"ID", "ds1", "Orders", "sales", "Shared"} {
		if !strings.Contains(out, want) {
			t.Errorf("table missing %q:\n%s", want, out)
		}
	}
}

func TestDatasetsTableNestedKeyAndFieldFallbacks(t *testing.T) {
	// Uses alternate field names (dataset_id, title, status) and the "datasets" key.
	raw := `{"datasets":[{"dataset_id":"ds2","title":"Users","status":"Personal"}]}`
	out, err := DatasetsTable(raw)
	if err != nil {
		t.Fatalf("DatasetsTable: %v", err)
	}
	if !strings.Contains(out, "ds2") || !strings.Contains(out, "Users") || !strings.Contains(out, "Personal") {
		t.Fatalf("field fallbacks not applied:\n%s", out)
	}
	// Missing domain should render as a placeholder, not crash.
	if !strings.Contains(out, "-") {
		t.Fatalf("missing field should render '-':\n%s", out)
	}
}

func TestDatasetsTableBadShape(t *testing.T) {
	if _, err := DatasetsTable(`{"nope":123}`); err == nil {
		t.Fatal("expected error for response with no array")
	}
}
