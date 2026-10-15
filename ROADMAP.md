# Roadmap

## V0: Observer and a walkable kitchen

Watch every Claude Code session as a cook: hooks and transcript tail, the four states,
commis for subagents, the ticket rail. Orbit overview and first-person walk. `?demo` mode
and a README GIF.

## V1: A brigade you can talk to

A head chef run by the server through the user's own `claude` CLI (ADR-015), with cooks at
fixed stations: hot, garde-manger, commis, pastry and dish (ADR-016). Walk up, press F and talk
to the head chef; it dispatches the work and its reports land on a whiteboard at the pass.
Peek at any cook read-only. Local SQLite for crew state and history. Command channel secured.

## V2: Scheduled crew

Crew roles on schedules that pick up order tickets (issues) and build OrderUp through PRs.
(npm publishing as a single bundled package landed early, in 0.1.0: ADR-013.)
