RX VISION — WINDOWS AGENT (SOURCE CODE)
=======================================

What this is
------------
The source code for the RX Vision desktop agent — the small Windows
application that runs on each employee's machine and records their
working activity.

Version: 2.9.1


What it does
------------
  * Records the foreground application and website once a minute
  * Detects idle time and a locked workstation
  * Detects and reports time the machine spent asleep
  * Takes a screenshot every 5 minutes (when enabled for that user)
  * Shows a floating button, a dashboard, and chat with the manager
  * Break / Lunch / Meeting / End Day controls
  * Updates itself when a newer build is published


Built with
----------
  C# / .NET 8  +  WinUI 3 (Windows App SDK 1.7)
  Self-contained, 64-bit Windows


How to build
------------
  1. Install the .NET 8 SDK and the Windows App SDK workload
  2. Open a terminal in this folder
  3. dotnet build -c Release

  Output appears under bin\Release\


Folder guide
------------
  Services\     The working parts of the agent
                  ActivityService  - takes and sends the readings
                  ApiClient        - all communication with the server
                  ChatService      - live chat with the manager
                  ScreenshotService- periodic screen capture
                  UpdateService    - self-update
                  LockWatcher      - detects a locked workstation
                  SystemInfo       - sleep detection, screen capture
                  SessionStore     - keeps the signed-in session
                  BrowserUrl       - reads the website from a browser

  Views\        The screens: floating button, dashboard, login
  ViewModels\   The data behind those screens
  Helpers\      Windows-specific helpers
  Assets\       Icon artwork


Settings
--------
  appsettings.json holds the server address and the timings.
  It contains no passwords or keys.


Note
----
  Build output (bin, obj) and the published application have been
  left out, as has the per-company enrolment file, which contains a
  security token and must never be shared.

  The installer is a separate small project and is not included here.
