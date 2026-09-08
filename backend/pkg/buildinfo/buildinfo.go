// Package buildinfo exposes only public release identity, never runtime config.
package buildinfo

// Version and Commit are injected by release builds. Plain go build keeps useful
// development defaults; no repository path, host, timestamp or user is embedded.
var (
	Version = "dev"
	Commit  = "unknown"
)

type Info struct {
	Version string `json:"version"`
	Commit  string `json:"commit"`
}

func Current() Info {
	v, c := Version, Commit
	if v == "" {
		v = "dev"
	}
	if c == "" {
		c = "unknown"
	}
	return Info{Version: v, Commit: c}
}
