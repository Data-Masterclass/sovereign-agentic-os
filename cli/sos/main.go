// SPDX-License-Identifier: Apache-2.0
// Command sos is the governed developer CLI for the Sovereign Agentic OS.
package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"

	"github.com/sovereign-os/sos/internal/cli"
)

// version is set at build time via -ldflags "-X main.version=...".
var version = "dev"

func main() {
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt)
	defer cancel()

	if err := cli.NewRootCmd(version).ExecuteContext(ctx); err != nil {
		fmt.Fprintln(os.Stderr, "sos: "+err.Error())
		os.Exit(1)
	}
}
