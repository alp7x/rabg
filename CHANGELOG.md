# v1.0.0 (2026/07/26)
- The extension is now available for both Firefox and Chrome!

# v1.1.0 (2026/07/27)
- Mobile support for Firefox!
- Mastered badges and Beaten badges are now shown under separate subheadings rather than alongside each other.
- Softcore Beaten badges and their count are now displayed as well.
- The extension will manually create a Game Awards section for users who don't have any Masteries, in order to display their Beaten badges.
- The extension can now generate Beaten badges for users with hundreds of Mastery badges.

# v1.2.0 (2026/07/28)
- You can now sort your beaten badges alphabetically! At the very bottom of the page (i.e. the footer section of the website), there'll be a settings section that lets you adjust the way the beaten badges are sorted.

# v1.3.0 (2026/09/03)
- You can now also access RABG settings by clicking the extension icon. It includes every footer setting, styled after RetroAchievements' own design, and follows your site theme.
- You can now make your Beaten badges smaller and/or desaturate them, so they look less flashy than your Mastered badges. Two new sliders, "Beaten Size" and "Beaten Color", can be found in the RABG settings.
- You can now manually order your Beaten badges and hide the ones you don't want to display (for your own profile only). Enable "Manual Order" in the RABG settings, then press the "Edit Badges" button: the page will scroll straight to your beaten badges, and then you can press and hold a badge to drag it around. You can click the ✕ button on a badge to hide it. Hidden badges can be restored via ＋ button. When you're done, click the "Finish Editing" button to save your changes. New beaten games will appear at the end of the list, visible by default.
- You can now export and import all your RABG settings (sorting, size, color, manual order, hidden badges) as a JSON file. Handy for backing up or moving your settings between browsers.
- Various polish and backend improvements.

# v1.3.1 (2026/09/04)
- Fixed an issue where the Manual Order setting was not appearing on the mobile version of the website.
- Fixed extension popup scaling/zoom issues on mobile devices.
- Fixed a layout issue on mobile that caused extension to create an excessive whitespace below the footer.
- Fixed an issue on touch devices where dragging Beaten badges would scroll the page instead of moving the badge.
- Improved Manual Order toggle responsiveness on touch devices.

# v1.4.0 (2026/10/21)
- RABG now shows **all** of your beaten games, not just the ones RetroAchievements lists under Completion Progress (i.e. profiles with over a thousand beaten games now work too). The complete list is loaded in the background from the progress pages: badges appear as they arrive, and the list is remembered, so the next visit is instant. It is refreshed automatically whenever your beaten totals change.
- New **Sync** button to reload the full list manually. A status line shows the progress and the last sync time, and "Synced ✓" appears next to the Beaten title when it's done.
- New Beaten Sort options: "Time to Beat" (shortest / longest) and "Last Unlock" (newest / oldest). Last Unlock is the date of your most recent achievement unlock in that game.
- Manual Order editing has a new toolbar under the Beaten title: **Reset** (back to the default order, with a confirmation), **Discard** (leave without saving) and **Save** (renamed from "Finish Editing").
- Without a saved arrangement, Manual Order now follows your Sort setting.
- Remembered lists are kept for the 20 most recently visited profiles; your own profile is always kept and doesn't count towards that limit.
- Settings import now checks the file and tells you what was imported (or why not). Export no longer includes cached game data.
- Fixed: a damaged or hand-edited Manual Order setting could make the whole Beaten section disappear.
- Fixed: saving a Manual Order arrangement could forget the order/hidden state of games that weren't shown at that moment.
- Fixed: the Beaten Size / Beaten Color sliders could jump back while dragging.
- Fixed: Manual Order didn't work when the capitalization of the profile URL differed from your username. Your existing arrangement is kept.
- Fixed: scrolling on a phone could flip the Manual Order switch if your finger ended on it.
- Fixed: a stray divider line could appear on profiles without Mastered badges after changing a setting.
- The extension no longer does background work on pages other than profiles.
- Various small clean-ups and improvements.

# v1.4.1 (2026/11/13)
- When your beaten totals change, RABG now reads only the newest page of your completion progress instead of every page. And if the numbers don't add up afterwards, it automatically does a full reload (The Sync button always does the full reload).
- The badges you already had now stay on screen while the list is refreshed, instead of the Beaten section emptying and filling up from scratch again.
- The newest page of the completion progress is now checked quietly every time you open a profile, so Percentage and Last Unlock sorts stay up to date even if your beaten totals didn't change (e.g. when earning more achievements in a game you had already beaten).
- While editing the Manual Order, the page now auto-scrolls when you hold a badge near the top or bottom edge of the window, so badges can be moved across more easily on a long list.
- Sync is now more reliable. A page that fails to load is retried automatically ("retrying" is shown), being offline is reported right away instead of staying on "Loading…", and a failed sync is shown in red.
- RABG is now faster on big profiles. A refresh that brings nothing new doesn't redraw the entire Beaten section.
- Remembered lists take up less storage. If the browser's storage for the extension ever fills up, older remembered lists are dropped automatically.
- Fixed: while dragging, a badge could not be moved back to the place it started from (the preview didn't go there).
- Fixed: a badge dragged while the page was scrolling (e.g. with the mouse wheel) could land in the wrong place.
- Fixed: games with almost identical percentages could be ordered slightly differently after a reload.
- Accessibility: Screen readers now announce the RABG settings and the badge links by name.
