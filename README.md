# usage-bar

A visual usage bar for Claude Code. It sits above your prompt and shows how much of your limits you have used, when you will run out at your current pace, and where your tokens went. One click shrinks it to a small gauge.

![The usage bar, limit gauges and weekly forecast](docs/preview.jpg)

## What it shows

**The bar**

- 5-hour and weekly limits, with reset times and an even-pace marker
- A forecast of when you run out, such as "Expected run out Sunday afternoon"
- Tokens used today

**The forecast colours**

| Colour | Meaning |
| --- | --- |
| Green | You reach the reset, or later |
| Orange | You run out less than 24 hours before the reset |
| Red | You run out more than 24 hours before the reset |

The pace is your whole week so far, run forward from your last reading.

**The full view**

- A gauge for every limit, each with its own pace and run-out time
- A weekly forecast chart: the week so far, the even pace and where you are heading
- Tokens for today, this week, this month, this year and all time, split into this session and other sessions
- Each period compared with the same point in the one before
- Context used, session cost, last 5 hours, pace and daily average
- Averages and records: per reply, per session, busiest hour and weekday, active streak
- Today by the hour, day by day, months and years
- Input, output and cache tokens, models by period, top projects and top sessions
- A weekday by hour heatmap of when you use Claude

Numbers pick their own unit: `850K`, `50.2M`, `4.41B`.

## Install

At the prompt of a terminal session:

```
/plugin install usage-bar --marketplace KRish571215111/usage-bar
```

Answer `y` to add the marketplace, then pick a scope.

From a shell:

```bash
claude plugin install usage-bar --marketplace KRish571215111/usage-bar
```

In the desktop app, where `/plugin` does not run: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `KRish571215111/usage-bar`, then **Add plugin**.

**You need** Claude Code 2.1.317 or newer and [Node.js](https://nodejs.org) on your PATH. Node.js counts the tokens. The limits and forecast work without it.

## Use it

| Button | What it does |
| --- | --- |
| Gauge | Minimises the bar to the gauge. Click again to bring it back. |
| ⤢ | Opens the full view above the prompt |
| ✕ | Closes the full view back down to the gauge |

| Command | What it does |
| --- | --- |
| `/usage-bar disable` | Hides the bar and stops the background counting. It stays off in new sessions. |
| `/usage-bar enable` | Brings the bar back |
| `/usage-bar` or `/usage-bar details` | Opens the full details in a side pane |

To remove the plugin altogether:

```bash
claude plugin uninstall usage-bar
```

## Where it works

| Surface | What you get |
| --- | --- |
| Desktop app | The bar, the full view and the pane, with charts |
| VS Code | The pane with charts. VS Code has no band above the prompt, so there is no bar. |
| Terminal | The bar and details as text. Terminals cannot draw the charts. |

## Good to know

- **Limits update with replies.** Claude Code gives a mod your limits only with each response. Chats with the mod share their readings, so the bar catches up after the next reply in any of them, and it tells you how old a reading is. Usage on your phone, on the web, or in chats opened before you installed the mod shows up late, so the numbers can briefly sit below the usage screen in Settings. Limits only exist on a subscription plan.
- **Token totals include cache reads**, which are usually most of the number.
- **Tokens are counted on this computer.** Usage on claude.ai or your phone counts towards your limits but not the token totals.
- **"All time" starts at your oldest transcript.** Claude Code cleans old transcripts away. Totals already counted stay, but anything cleaned before you installed this cannot be counted.
- **Times use your computer's timezone.**

## Privacy

Everything stays on your computer. The scanner reads your Claude Code transcripts in `~/.claude/projects` and keeps only numbers: token counts, hashed message ids, and project and session names. It does not keep message text, and it sends nothing anywhere.

The totals live in `~/.claude/usage-bar`. To keep them somewhere else, set the `USAGE_BAR_CACHE_DIR` environment variable to a folder.

## Develop

```bash
claude plugin validate .
claude plugin test .
claude --plugin-dir .
```

## License

[MIT](LICENSE)
