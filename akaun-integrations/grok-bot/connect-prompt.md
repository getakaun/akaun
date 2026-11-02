Connect Akaun as a custom connector. Akaun is my bookkeeping app.

- MCP server: <AKAUN_BASE_URL>/mcp. Replace <AKAUN_BASE_URL> with my Akaun
  installation's public HTTPS origin, without a trailing slash. If I have not
  supplied it, ask me for the address; never guess a hostname.
- Use Streamable HTTP and OAuth. Show me the Connect button so I can sign in
  to Akaun and choose which permissions to grant on its consent page. The page
  offers all supported scopes; I will select the read, change, delete, adjustment
  or correction access I want to allow. Do not limit setup to read access or
  choose additional permissions on my behalf.
- Discover OAuth endpoints from <AKAUN_BASE_URL>/.well-known/oauth-protected-resource/mcp,
  then the authorization server metadata it points to. Use the advertised
  authorization, token and registration endpoints; never invent them. Keep
  passwords and tokens out of this conversation.
- If this Grokbot cannot create custom MCP connections or complete OAuth, say
  exactly what is unsupported and give me the manual setup steps. Do not claim
  to have connected. If OAuth is disabled, tell me it needs to be enabled on
  my Akaun server, or use a personal access token only through the client's
  secure credential settings if supported.

After connecting:

1. Call `list_tools` for the Akaun connection (MCP `tools/list`), following
   pagination until all available tools have been discovered. Read their
   descriptions and input schemas and follow Akaun's server instructions.
   Use only the tools actually returned; do not assume every feature is granted.
   If `list_tools` is unavailable or fails, report that and stop setup verification.
   If expected tools are missing, explain which granted scopes, account
   permissions or administrator delegation limits may be restricting them.
   Offer reconnection so I can revise my choices, then call `list_tools` again.
2. Make one small read-only request with a discovered tool, preferably
   `list_accounts` with `limit: 1` if its schema supports that. Otherwise use
   another available read-only tool with the smallest useful result. Do not
   create, edit, issue, match, confirm imports, or delete anything to test the
   connection. If no read-only tool is available, say verification is incomplete.
3. Confirm the server address, whether tool discovery and the read check
   succeeded, and the capabilities available through this connection. Summarize
   what you can help me do and any permission limits; there is no need to dump
   my financial data or every tool schema. An empty successful read is valid.
   If anything failed, identify the step and returned error, explain the next
   action, and distinguish what succeeded from what remains unverified. Never
   report full success based only on a completed OAuth sign-in or tool listing.

Use this connection for my subsequent Akaun requests. Granted permissions are
not a request to change data: act on my instructions and follow the server's
review and confirmation requirements for changes.
