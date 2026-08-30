package main

import (
	"fmt"
	"log"
	"os/exec"

	"github.com/blang/semver"
	"github.com/fatih/color"
	"github.com/pbnjay/memory"
)

const bunSemverRange = ">=1.4.0 <2.0.0"
const ramMin = 768

// CheckBun checks if Bun is installed and has a supported version.
func CheckBun() bool {
	cmd := exec.Command("bun", "--version")
	cmdOutput, err := cmd.CombinedOutput()
	if err != nil {
		log.Fatal(err)
	}

	validRange := semver.MustParseRange(bunSemverRange)
	bunVersion, err := semver.ParseTolerant(string(cmdOutput))
	if err != nil {
		panic(fmt.Errorf(color.RedString("Error: Failed to parse Bun version: %s\n"), err))
	}
	if !validRange(bunVersion) {
		panic(fmt.Errorf(color.RedString("Error: Installed Bun version %s is not supported! %s\n"), bunVersion, bunSemverRange))
	}

	fmt.Printf(color.GreenString("✔")+" Bun %s: OK\n", bunVersion.String())

	return true
}

// CheckRAM checks if system total RAM meets requirements
func CheckRAM() bool {
	var totalRAM = memory.TotalMemory() / 1024 / 1024
	if totalRAM < ramMin {
		panic(fmt.Errorf(color.RedString("Error: System does not meet RAM requirements. %s MB minimum.\n"), ramMin))
	}

	fmt.Printf(color.GreenString("✔")+" Total System RAM %d MB: OK\n", totalRAM)

	return true
}

// CheckNetworkAccess checks if download server can be reached
func CheckNetworkAccess() bool {
	// TODO
	return true
}
