# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
#
# A one-tool MCP server (streamable HTTP on :8000/mcp) for scripts/tests/litellm-oss/run.sh, built on the
# MCP Python SDK (MIT) that the gateway image already carries. Tool `echo` returns its text prefixed.
from mcp.server.mcpserver import MCPServer

server = MCPServer(name="probe")


@server.tool()
def echo(text: str) -> str:
    """Echo the text back."""
    return f"probe-echo:{text}"


server.run(transport="streamable-http", host="0.0.0.0", port=8000)
