// SPDX-License-Identifier: Apache-2.0
// Package output renders MCP JSON responses for the terminal: aligned tables and
// pretty JSON. Kept pure (string in, string out) so it is directly testable.
package output

import (
	"encoding/json"
	"fmt"
	"strings"
)

// Table renders rows of equal-length string slices under the given headers, with
// space-padded columns. Empty rows yield a "(no rows)" line.
func Table(headers []string, rows [][]string) string {
	if len(rows) == 0 {
		return "(no rows)\n"
	}
	widths := make([]int, len(headers))
	for i, h := range headers {
		widths[i] = len(h)
	}
	for _, row := range rows {
		for i := 0; i < len(headers) && i < len(row); i++ {
			if len(row[i]) > widths[i] {
				widths[i] = len(row[i])
			}
		}
	}
	var b strings.Builder
	writeRow(&b, headers, widths)
	sep := make([]string, len(headers))
	for i, w := range widths {
		sep[i] = strings.Repeat("-", w)
	}
	writeRow(&b, sep, widths)
	for _, row := range rows {
		writeRow(&b, row, widths)
	}
	return b.String()
}

func writeRow(b *strings.Builder, cols []string, widths []int) {
	for i, w := range widths {
		cell := ""
		if i < len(cols) {
			cell = cols[i]
		}
		if i > 0 {
			b.WriteString("  ")
		}
		fmt.Fprintf(b, "%-*s", w, cell)
	}
	b.WriteString("\n")
}

// PrettyJSON re-indents a JSON string. If the input is not valid JSON it is returned
// unchanged (governed tools return JSON text, but be defensive).
func PrettyJSON(raw string) string {
	var v any
	if err := json.Unmarshal([]byte(raw), &v); err != nil {
		return raw
	}
	out, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return raw
	}
	return string(out)
}

// DatasetsTable turns a list_datasets JSON payload into a table. It is tolerant of
// two common shapes: a top-level array, or an object with a "datasets"/"items" array.
// Each element is expected to be an object; id/name/domain/tier fields are shown
// when present.
func DatasetsTable(raw string) (string, error) {
	items, err := extractArray(raw, "datasets", "items", "results")
	if err != nil {
		return "", err
	}
	headers := []string{"ID", "NAME", "DOMAIN", "TIER"}
	rows := make([][]string, 0, len(items))
	for _, it := range items {
		rows = append(rows, []string{
			field(it, "id", "dataset_id", "slug"),
			field(it, "name", "title", "display_name"),
			field(it, "domain", "domain_id", "scope"),
			field(it, "tier", "status", "visibility"),
		})
	}
	return Table(headers, rows), nil
}

// extractArray finds a JSON array either at the top level or under one of the given
// object keys.
func extractArray(raw string, keys ...string) ([]map[string]any, error) {
	trimmed := strings.TrimSpace(raw)
	if strings.HasPrefix(trimmed, "[") {
		var arr []map[string]any
		if err := json.Unmarshal([]byte(trimmed), &arr); err != nil {
			return nil, fmt.Errorf("parse array response: %w", err)
		}
		return arr, nil
	}
	var obj map[string]json.RawMessage
	if err := json.Unmarshal([]byte(trimmed), &obj); err != nil {
		return nil, fmt.Errorf("parse response: %w", err)
	}
	for _, k := range keys {
		if v, ok := obj[k]; ok {
			var arr []map[string]any
			if err := json.Unmarshal(v, &arr); err != nil {
				return nil, fmt.Errorf("parse %q array: %w", k, err)
			}
			return arr, nil
		}
	}
	return nil, fmt.Errorf("no array found in response (looked for %s)", strings.Join(keys, ", "))
}

// field returns the first present, non-empty stringified value among the keys.
func field(m map[string]any, keys ...string) string {
	for _, k := range keys {
		if v, ok := m[k]; ok && v != nil {
			s := stringify(v)
			if s != "" {
				return s
			}
		}
	}
	return "-"
}

func stringify(v any) string {
	switch t := v.(type) {
	case string:
		return t
	case float64:
		return strings.TrimSuffix(fmt.Sprintf("%v", t), ".0")
	case bool:
		return fmt.Sprintf("%v", t)
	default:
		b, _ := json.Marshal(v)
		return string(b)
	}
}
