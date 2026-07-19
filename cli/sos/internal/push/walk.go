// SPDX-License-Identifier: Apache-2.0
package push

import (
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"unicode/utf8"
)

// maxFileBytes caps a single file's size. The governed commit path is for source
// (dbt/Cube/app code), not blobs; a large binary is almost certainly a mistake
// (node_modules, build output) and would bloat the governed change.
const maxFileBytes = 1 << 20 // 1 MiB

// defaultIgnores are directory/file names never pushed: VCS metadata, dependency
// and build output. Kept small and obvious; extend via .sosignore if needed.
var defaultIgnores = map[string]bool{
	".git":         true,
	"node_modules": true,
	".next":        true,
	"dist":         true,
	"build":        true,
	".venv":        true,
	"__pycache__":  true,
	".sos":         true,
}

// WalkDir reads a local working directory into a slash-keyed {path: content} map
// suitable for Diff. It skips ignored dirs, refuses files above maxFileBytes, and
// skips non-UTF-8 (binary) files — the governed `commit` tool carries text
// content only. Symlinks are not followed.
func WalkDir(root string) (map[string]string, error) {
	info, err := os.Stat(root)
	if err != nil {
		return nil, err
	}
	if !info.IsDir() {
		return nil, fmt.Errorf("%s is not a directory", root)
	}
	out := map[string]string{}
	walkErr := filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			if p != root && defaultIgnores[d.Name()] {
				return fs.SkipDir
			}
			return nil
		}
		if !d.Type().IsRegular() { // skip symlinks, sockets, devices
			return nil
		}
		rel, err := filepath.Rel(root, p)
		if err != nil {
			return err
		}
		norm, err := NormalizePath(filepath.ToSlash(rel))
		if err != nil {
			return err
		}
		fi, err := d.Info()
		if err != nil {
			return err
		}
		if fi.Size() > maxFileBytes {
			return fmt.Errorf("%s is %d bytes, over the %d-byte push limit (exclude build output / large blobs)", norm, fi.Size(), maxFileBytes)
		}
		b, err := os.ReadFile(p)
		if err != nil {
			return err
		}
		if !utf8.Valid(b) {
			// Binary file: not part of a governed source changeset. Skip, don't fail.
			return nil
		}
		out[norm] = string(b)
		return nil
	})
	if walkErr != nil {
		return nil, walkErr
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("no pushable text files found under %s", root)
	}
	return out, nil
}

// SortedPaths returns the map's keys sorted — handy for deterministic output.
func SortedPaths(m map[string]string) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}
