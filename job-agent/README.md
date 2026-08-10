# job-agent

An agent that opens a job posting, fills the application form out with your
details, and submits it.

It drives a real browser, so it works on the form as rendered — Greenhouse,
Lever, Ashby, SmartRecruiters, and plain HTML career pages. Every answer comes
from a profile file you write. When the form asks something your profile doesn't
cover, the agent reports the gap instead of inventing an answer.

## Safety model

- **Dry run is the default.** `job-agent apply <url>` fills the form, screenshots
  it, and stops. Nothing is submitted without `--submit`.
- **It won't submit a half-answered application.** If a *required* field has no
  answer in your profile, submission is blocked and the field is named.
- **It won't apply twice.** Every attempt is logged; a posting already in the log
  is skipped unless you pass `--force`.
- **It never makes anything up.** Answers come from your profile. With `--ai`,
  Claude rewrites *your* material and is instructed to decline rather than
  invent; anything it declines stays blank.

You are the applicant, so the accuracy of what's submitted is on you — read the
screenshot in `runs/` before trusting a `--submit` run. Some job boards restrict
automated submissions in their terms; that's worth a look for sites you use
heavily.

## Setup

```bash
cd job-agent
npm install
npx playwright install chromium   # skip if Chrome/Chromium is already installed

cp profile.example.json profile.json
$EDITOR profile.json              # your details, your resume path
job-agent check                   # validates the profile
```

`node src/cli.js <command>` works too if you'd rather not link the binary.

## Use

```bash
# See what it would do — fills the form, screenshots it, submits nothing
node src/cli.js apply https://boards.greenhouse.io/acme/jobs/1234567

# Send it
node src/cli.js apply https://jobs.lever.co/acme/abc123 --submit

# Tailor the cover letter and freeform answers with Claude
node src/cli.js apply https://boards.greenhouse.io/acme/jobs/1234567 --ai --submit

# Work through a list (see jobs.example.json)
node src/cli.js queue jobs.json --limit 5 --submit

# What have I applied to?
node src/cli.js log
```

Each run writes to `runs/<timestamp>-<company>/`:

| File | What it is |
| --- | --- |
| `filled.png` | Full-page screenshot of the completed form |
| `after-submit.png` | The page after submitting (only on `--submit`) |
| `cover-letter.txt` | The letter that was used |
| `plan.json` | Every field, what went in it, and what was skipped |

### Options

| Flag | Meaning |
| --- | --- |
| `--profile <path>` | Profile JSON (default `./profile.json`) |
| `--submit` | Actually submit. Without it, the agent fills and stops. |
| `--ai` | Use Claude for the cover letter and freeform questions |
| `--headed` | Watch the browser work |
| `--company` / `--role` | Override what's guessed from the page |
| `--force` | Re-apply to a logged posting; submit despite warnings |
| `--limit` / `--delay` | `queue`: cap the run, and seconds between applications |
| `--out` / `--log` | Artifact directory and log path |

## The profile

`profile.example.json` is a filled-in example. The parts that do the most work:

- **`documents.resume`** — path to your resume, relative to the profile file.
  Without it, file uploads are skipped and most applications won't submit.
- **`highlights`** — your accomplishments, each with `keywords`. The agent ranks
  these against the job description and puts the best three in the cover letter.
- **`answers.custom`** — a list of `{ match, answer }` pairs for questions no
  generic rule covers ("Are you comfortable with on-call?"). The `match` is
  matched as a substring of the question; the most specific match wins.
- **`eligibility`** — booleans like `workAuthorized`. These map onto whatever
  Yes/No wording the form uses.
- **`demographics`** — EEO answers. "Prefer not to say" matches whichever
  decline-to-answer phrasing a given form uses.

## How a field gets filled

1. **Read the form.** Every control is described by its label, `aria-label`,
   placeholder, `name`, and `id` — read the way a person reads it, including
   wrapping `<label>`s and `<fieldset>` legends.
2. **Match it to a meaning.** Scored against a rule set, weighted toward the
   visible label, so `name="field_98217"` with a label of "Email" still resolves.
   Rules veto each other where they'd collide, so "Company website" doesn't get
   your employer's name.
3. **Resolve an answer** from your profile, then `answers.custom`.
4. **Fit it to the control.** Booleans become the form's own "Yes"/"No" option
   text; a cover letter is typed into a textarea or uploaded to a file input.
   If no option is a genuine match, the field is skipped and reported.

## Limits

- **Workday** applications span several pages and usually want an account. The
  agent detects them, fills the first page, and stops rather than half-submitting.
- **Logins and CAPTCHAs** are not automated. Use `--headed` to solve them yourself.
- **Confirmation is best-effort.** After submitting, the agent looks for the
  phrases boards show on success. Status `unconfirmed` means the click landed but
  the wording wasn't recognized — check `after-submit.png`.

## Tests

Run from the repository root:

```bash
npx vitest run tests/job-agent-*.test.js
```

Covers field matching, answer resolution, option fitting, planning, cover-letter
assembly, ATS detection, and the duplicate guard.
