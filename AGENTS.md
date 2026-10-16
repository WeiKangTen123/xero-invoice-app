# Shared agent memory (Claude Code + Antigravity)

Both agents read this file at startup. At the end of every task,
append a dated entry under Log: what you changed, what is pending,
anything the other agent must know. Keep entries short. Prune old
entries when the file grows past a screen or two.

Working rules for both agents:
- Split work by area. Do not edit a file the other agent is working on.
- Commit only when the user asks.
- Never put secrets or tokens in this file.

## Log

