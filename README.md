# rapid-fire — The Lost Schema

A 2D treasure-hunt wrapper around rapid-fire SQL MCQs for the NST DBMS lab.
120 students, all 9 rounds in one ~75-minute sitting, on free tiers.

## Docs
- `docs/PROMPT.md` — the build spec (paste below the divider into Codex; use GPT-6 Astra, high reasoning).

## Core rules
- Sealed rounds: no hints, no feedback; answers revealed only at the end-of-round debrief.
- Access only while a lab session is live (DB-enforced); no access after it closes.
- 12 s per MCQ, single-answer, 4 options; tables rendered as tables, stems short and catchy.

## Stack
Vite + React + TypeScript + Phaser 4 · Supabase (Postgres RPCs, Auth, Realtime, Storage) · Cloudflare Pages.
