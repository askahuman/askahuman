package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"

	"github.com/askahuman/askahuman/backend/pkg/buildinfo"
)

func runVersion(args []string) error {
	fs := flag.NewFlagSet("version", flag.ContinueOnError)
	asJSON := fs.Bool("json", false, "print public version and commit as JSON")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if fs.NArg() != 0 {
		return fmt.Errorf("version takes no positional arguments")
	}
	info := buildinfo.Current()
	if *asJSON {
		return json.NewEncoder(os.Stdout).Encode(info)
	}
	_, err := fmt.Fprintf(os.Stdout, "ask-a-human %s (%s)\n", info.Version, info.Commit)
	return err
}
