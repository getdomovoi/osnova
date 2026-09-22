# Records assets/demo/warp.gif. Run from a checkout of the click corpus (benchmarks/click-v1.json) with
# vhs installed; vhs 0.12.0 writes frames only, so encode them with the ffmpeg command in assets/demo/README.md.
Output "frames/"
Set Shell bash
Set FontFamily "JetBrainsMono Nerd Font"
Set FontSize 14
Set Width 1600
Set Height 540
Set Padding 24
Set TypingSpeed 35ms
Set Theme { "name": "osnova", "background": "#0D0E0F", "foreground": "#E8E6E3", "cursor": "#C89B4A", "selection": "#232528", "black": "#141517", "red": "#C89B4A", "green": "#6FA3A8", "yellow": "#C89B4A", "blue": "#6FA3A8", "magenta": "#9A9894", "cyan": "#6FA3A8", "white": "#E8E6E3", "brightBlack": "#9A9894", "brightRed": "#C89B4A", "brightGreen": "#6FA3A8", "brightYellow": "#C89B4A", "brightBlue": "#6FA3A8", "brightMagenta": "#9A9894", "brightCyan": "#6FA3A8", "brightWhite": "#E8E6E3" }
Env PS1 "$ "
Hide
Sleep 500ms
Show
Type "osnova warp 'src/click/core.py#Context.invoke'"
Sleep 600ms
Enter
Sleep 6s
Type "clear" Enter
Type "grep -rn '\.invoke(' src/click | wc -l"
Sleep 400ms
Enter
Sleep 2s
Type "osnova plumb 'src/click/core.py#Context.invoke' $(grep -rn '\.invoke(' src/click | cut -d: -f1,2 | sed 's/^/--site /')"
Sleep 600ms
Enter
Sleep 9s
