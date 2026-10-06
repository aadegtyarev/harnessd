# Method and scenario index

## Method

Read the approved feature contract, meta-contract, affected surface contracts, relevant source and tests, README, and a supplied research artifact of official Telegram documentation. This is an evidence-based audit of current behavior, not a live walkthrough. No secrets or `.env` were read.

### Telegram references

- [Guidelines: speed](https://core.telegram.org/bots/guidelines#1-1-speed)
- [answerCallbackQuery](https://core.telegram.org/bots/api#answercallbackquery) and [CallbackQuery](https://core.telegram.org/bots/api#callbackquery)
- [Input and Navigation](https://core.telegram.org/bots/guidelines#2-input-and-navigation), [Keyboards](https://core.telegram.org/bots/features#keyboards)
- [Inline keyboards](https://core.telegram.org/bots/features#inline-keyboards), [inline keyboard guidance](https://core.telegram.org/bots/guidelines#2-4-inline-keyboards)
- [ForceReply](https://core.telegram.org/bots/api#forcereply)
- [Commands](https://core.telegram.org/bots/guidelines#2-1-commands), [Menu Button](https://core.telegram.org/bots/features#menu-button)
- [Making requests](https://core.telegram.org/bots/api#making-requests)

`answerCallbackQuery` is an API requirement. One-time confirmations, truthful progress, consequence wording, and specific recovery buttons are audit recommendations, not Telegram mandates.

## Scenario index

| Scenario | Source route / evidence | Findings or note |
|---|---|---|
| First entry, `/help`, `/start` | `src/command-catalog.ts:36–185`; `src/telegram-transport.ts:1694–1696,1929` | F16 |
| `/menu`, browse/select, preview | `src/telegram-transport.ts:2159–2315,3041–3102`; tests `1021–1064,1150–1201` | F03, F04, F09 |
| Sessions list/details/use/create/rename | `src/telegram-transport.ts:1594–1628,1800–1880,1932–2090,3105–3191`; tests `1663–1753` | F03, F07, F17 |
| Folders, paths, navigation | `src/telegram-transport.ts:1640–1692,3210–3315`; `src/telegram-filesystem.ts:17–119`; tests `1066–1097,1755–1818` | F04, F05, F17 |
| Stop/resume/delete and eligibility | `src/telegram-transport.ts:1840–1905,3498–3635`; `src/core/session-manager.ts:107–123`; tests `1121–1148` | F02, F08, F18 |
| Model/effort/status | `src/telegram-transport.ts:737–753,1697–1798,3317–3496`; core `579–634`; tests `529–540,1532–1661` | F04, F08, F14; partial success correctly reported |
| Text, activity, uncertainty, cancel | `src/telegram-transport.ts:1269–1350,2551–3010,3680–3790`; Pi RPC `1091–1221`; tests `542–580,1867–1963,2309–2365` | F01, F06, F10–F12, F14–F15 |
| Photos, documents, outgoing files | `src/telegram-transport.ts:1353–1582,1630–1638`; inbox `150–235`; tests `1970–2307` | F02, F06, F12–F13 |
| Callbacks/confirmations and errors | `src/telegram-transport.ts:2092–2135,2339–2345,2456–2505`; tests `1355–1376,2516–2543` | F05, F18; callbacks are acknowledged before action |
| Output, switch, backpressure, restart | `src/telegram-transport.ts:480–598,1192–1214,3862–4154`; tests `821–872,1186–1310,2429–2821` | F09–F11; formatting/no-resend/restart guarantees verified |
| Language, terminology, identity | `src/telegram-transport.ts:600–612,737–753,2621–2658,3914–3922` | F14, F16–F17 |

All feature-contract scope areas are represented. “Covered” means routes and conditions inspected in source/tests, not live Telegram/Pi execution. See [findings](findings-context.md) and [evidence gaps](evidence-gaps.md).
