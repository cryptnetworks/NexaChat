# Presence policy

Presence is coarse, ephemeral coordination state—not an activity history. A
heartbeat may publish only `online` or `idle`, expires after 90 seconds, and is
accepted at most every 15 seconds per account across replicas. `Online` means a
client explicitly reported availability; it does not imply attention. Routes,
window titles, keystrokes, and precise last-active times are never collected.
Expired, blocked, suspended, unauthorized, and disconnected accounts render as
`offline`. Valkey loss degrades all results to offline and cannot grant access.
