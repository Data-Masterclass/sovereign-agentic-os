// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
//
// FEATURE: App Builder build pod (workstream C1) - tests of the user-namespace check.
// USER STORY: As a platform owner I want proof that the initial namespace and a root-to-root map are refused.
// ARCHITECTURE: go test, run by the image build before the binary is copied.

package main

import (
	"strings"
	"testing"
)

func TestCheck(t *testing.T) {
	ok := []string{
		"         0 2885812224      65536\n", // kubelet's pod range (kind proof)
		"0 1 1\n1 2 65535\n",                 // nested map
	}
	for _, m := range ok {
		if err := Check(strings.NewReader(m)); err != nil {
			t.Errorf("%q refused: %v", m, err)
		}
	}
	bad := []string{
		"         0          0 4294967295\n", // initial namespace: hostUsers dropped
		"0 0 65536\n",                        // root maps to the node's root
		"",                                   // nothing
		"0 x 1\n",                            // garbage
	}
	for _, m := range bad {
		if err := Check(strings.NewReader(m)); err == nil {
			t.Errorf("%q accepted", m)
		}
	}
}
