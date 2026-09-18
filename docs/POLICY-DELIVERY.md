# Policy-only delivery

`pac policy sync PROFILE_REPOSITORY COMMIT BASELINE [codex,claude,agy,grok]`
delivers the selected Profile's embedded Skills, Core's two embedded Skills,
and bootstrap/kernel instructions. Both revisions are full immutable Profile
commit IDs. Run `pac --json policy status` to verify the installed file hashes.

This path serves machines that lack PAC's complete package/tool environment.
It does not install agent binaries, upstream APM packages, plugins, MCP servers,
credentials or permission settings. It does not install or activate hooks and
is not a successful full `pac doctor`. Existing upstream Skills are preserved.
The ordinary `pac apply` route remains the owner of complete installations.

When a full installation is present, update it with `pac apply` first. Policy
delivery then verifies its neutral Skills and adds only compatibility views;
it does not take ownership of the full installation's existing projections.
Codex/Claude remain the full PAC host adapters. Grok and Antigravity support
here means native policy/Skill discovery, not a new full host adapter.

The command permits replacement only when the current content matches the
declared baseline, desired revision, or its previous owned hash. Unrelated and
edited content is preserved. Replacements are staged and verified, originals
are retained under the printed backup, and failures restore prior entries in
reverse order. The backup contains a plan, replacement journal and the prior
policy state when one existed. Interrupted-process recovery requires inspecting
that journal; do not delete its retained originals or restore unrelated paths.

Antigravity locations follow its official Skills and Rules documentation:
`~/.gemini/antigravity-cli/skills`, `~/.gemini/config/skills`, and CLI global
rules. A missing `~/.gemini/GEMINI.md` receives a small shared-kernel bridge;
an existing unmanaged global file is preserved. Grok uses `~/.grok/skills`
and a small rules bridge while retaining its native compatibility settings.

References: https://antigravity.google/docs/skills/ and
https://antigravity.google/docs/rules-workflows/.
