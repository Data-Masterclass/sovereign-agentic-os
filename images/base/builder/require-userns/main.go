// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
//
// FEATURE: App Builder build pod (workstream C1) - refuse to build unless the pod really has its own user namespace.
// USER STORY: As a platform owner I want the builder to stop before buildkitd starts when `hostUsers: false` did not
//   take effect (a cluster without the UserNamespacesSupport feature drops the field silently), so uid 0 in the build
//   pod can never be the node's root.
// ARCHITECTURE: the entrypoint of the buildkitd sidecar: reads /proc/self/uid_map and /proc/self/gid_map; refuses (exit
//   70) when the namespace is the initial one (the identity map "0 0 4294967295") or when id 0 inside maps to id 0
//   outside; otherwise execs its arguments (rootlesskit ... buildkitd ...). A second layer: the chart's
//   ValidatingAdmissionPolicy denies a build-image pod without spec.hostUsers == false. Stdlib only.

package main

import (
	"bufio"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"syscall"
)

// Check returns nil when the id map is a proper (non-initial) user namespace in which id 0 is not the host's id 0.
func Check(idMap io.Reader) error {
	sc := bufio.NewScanner(idMap)
	lines := 0
	for sc.Scan() {
		f := strings.Fields(sc.Text())
		if len(f) == 0 {
			continue
		}
		if len(f) != 3 {
			return fmt.Errorf("unreadable id map line %q", sc.Text())
		}
		inside, err1 := strconv.ParseUint(f[0], 10, 32)
		outside, err2 := strconv.ParseUint(f[1], 10, 32)
		count, err3 := strconv.ParseUint(f[2], 10, 32)
		if err1 != nil || err2 != nil || err3 != nil {
			return fmt.Errorf("unreadable id map line %q", sc.Text())
		}
		lines++
		if inside == 0 && outside == 0 && count == 4294967295 {
			return fmt.Errorf("this is the node's initial user namespace (identity map): hostUsers: false did not take effect")
		}
		if inside == 0 && outside == 0 {
			return fmt.Errorf("id 0 in this pod maps to the node's id 0")
		}
	}
	if err := sc.Err(); err != nil {
		return err
	}
	if lines == 0 {
		return fmt.Errorf("empty id map")
	}
	return nil
}

func checkFile(path string) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	if err := Check(f); err != nil {
		return fmt.Errorf("%s: %w", path, err)
	}
	return nil
}

func main() {
	args := os.Args[1:]
	if len(args) > 0 && args[0] == "--" {
		args = args[1:]
	}
	for _, p := range []string{"/proc/self/uid_map", "/proc/self/gid_map"} {
		if err := checkFile(p); err != nil {
			fmt.Fprintln(os.Stderr, "require-userns: REFUSED:", err)
			os.Exit(70)
		}
	}
	fmt.Fprintln(os.Stderr, "require-userns: own user namespace confirmed")
	if len(args) == 0 {
		return
	}
	bin, err := exec.LookPath(args[0])
	if err != nil {
		fmt.Fprintln(os.Stderr, "require-userns:", err)
		os.Exit(127)
	}
	if err := syscall.Exec(bin, args, os.Environ()); err != nil {
		fmt.Fprintln(os.Stderr, "require-userns: exec:", err)
		os.Exit(126)
	}
}
