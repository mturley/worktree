package main

import "embed"

//go:embed all:ui/dist
var EmbeddedWeb embed.FS
