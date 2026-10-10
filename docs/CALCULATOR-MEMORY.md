# Bundled calculator worker memory measurement

## Scope and reproduction

Run from the checkout with Node:

```powershell
node scripts/calculator/measure-memory.cjs
node tests/calculator.test.cjs
```

The measurement script uses the actual bundled `resources/clever-calculator/python/python.exe` and `worker.py`, with isolated Python flags (`-I -B -u`) through `CalculatorManager`. Runtime override environment variables are deliberately ignored. It starts one fresh worker, waits for protocol readiness, executes five sequential calls per mode, samples after the first and fifth call in each mode, then samples after 5 and 15 seconds idle. Each sample uses Windows PowerShell `Get-Process -Id <owned-worker-PID>`, refreshed `WorkingSet64` and `PrivateMemorySize64`. The same worker PID is required throughout. It emits raw bytes, converted MiB, environment versions and every call timing as JSON to stdout.

Only its own worker is queried and killed; the script does not enumerate other processes, inspect personal data, or kill processes by name. Cleanup runs in `finally`, waits for worker close, and also handles SIGINT/SIGTERM. No measurement output file is created automatically.

- **Working set** is currently resident process memory, including shared pages.
- **Private bytes** are private committed process memory, not necessarily all resident.
- **MiB = bytes / 1,048,576.** These are live process counters, not runtime download/extracted disk sizes or the whole Electron application's memory.

## Environment

Primary run completed **2026-10-10 04:23:47 UTC**, after the calculator tests completed, with no overlapping test process launched by this task.

| Item | Value |
| --- | --- |
| Windows / architecture | 10.0.26200.0 / x64 |
| CPU | Intel Core i7-14700HX, 28 logical CPUs |
| Installed physical memory | 40,667.87 MiB |
| Node | 24.15.0 |
| Windows PowerShell | 5.1.26100.9444 |
| Bundled Python | 3.13.12 |
| SymPy / mpmath | 1.14.0 / 1.3.0 |
| Owned worker PID for primary run | 69964 (terminated by script on completion) |

A fresh process does not imply a cold filesystem/antivirus cache. The script checks Python/package versions in a separate short-lived bundled process before timing worker readiness. These are point-in-time samples, not peak-memory profiling, leak certification or worst-case symbolic workloads. Other host activity was not controlled.

## Primary measured memory

Workloads are cumulative on one retained worker: calculus, then matrix, then ODE.

| Stage | Working set (MiB) | Private bytes (MiB) |
| --- | ---: | ---: |
| Ready, before calculations | 55.04 | 47.62 |
| First calculus call | 58.95 | 51.37 |
| Fifth calculus call | 58.95 | 51.37 |
| First matrix call | 58.96 | 51.37 |
| Fifth matrix call | 58.96 | 51.37 |
| First ODE call | 60.34 | 52.13 |
| Fifth ODE call | 60.77 | 52.13 |
| Idle 5 seconds | 60.77 | 52.13 |
| Idle 15 seconds | 60.77 | 52.13 |

Ready counters were **57,716,736 working-set bytes / 49,930,240 private bytes**; final/idle counters were **63,717,376 / 54,665,216 bytes**. The worker remained ready and alive at both idle checkpoints. Retaining it retains roughly **61 MiB resident / 52 MiB private committed** after these representative workloads; idle did not unload Python or SymPy. Repeated calls did not increase private bytes within a mode in this short run.

## Primary measured timing

Readiness (spawn through ready response) took **2,912.45 ms**. Calculation timings include manager dispatch, JSONL transport, computation and response handling, but exclude the PowerShell sampler. Each mode runs five times; the first call is first use of that mode on this process, not a separate cold process.

| Mode / representative input | Call 1 (ms) | Calls 2–5 (ms) |
| --- | ---: | --- |
| Calculus: `∫(x^2,x,0,1)` | 288.49 | 6.99, 5.15, 5.78, 5.40 |
| Matrix: `inverse([[1,2],[3,4]])` | 2.03 | 1.72, 1.34, 1.69, 1.67 |
| ODE: `y'+y=0`, condition `y(0)=1` | 213.19 | 62.26, 64.07, 68.30, 59.88 |

An earlier fresh-worker run, overlapping the calculator test execution, completed at 04:22:26 UTC: readiness **3,411.00 ms**, ready memory **55.28 / 47.21 MiB**, final and idle memory **61.28 / 52.68 MiB** (working set/private bytes). That run's first calculus/matrix/ODE calls were **321.94 / 3.35 / 358.57 ms**. This illustrates normal timing and allocation variation; use the non-overlapping primary run above rather than treating one number as a guarantee.

## Warmup regression coverage and backend changes

`tests/calculator.test.cjs` checks concurrent readiness calls spawn one worker; readiness-first and calculation-first startup sharing; retained idle worker reuse; busy rejection during startup; meaningful `CANCELLED` during startup and immediately after ready emission; shutdown during startup and immediately after readiness; ignored late ready output; and no respawn or writes after disposal. Existing real bundled-worker protocol, validation/security, dependency isolation, timeout/cancel/restart, packaged relocation and missing-runtime tests remain in place.

`electron/lib/calculator.cjs` preserves lifecycle stop reasons for startup cancellation/disposal/restart and checks a stop generation after awaiting readiness. This prevents a just-resolved readiness continuation from submitting work after cancellation or shutdown. Ordinary startup failures retain the existing `UNAVAILABLE` response. Worker protocol validation, request limits, isolated invocation and the one-calculation busy bound are unchanged.

Validation: `node tests/calculator.test.cjs` passed, including actual bundled runtime and relocated packaged layout. Both memory measurement invocations completed successfully and cleaned up their owned workers.
