// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

"use strict";

var childProcess = require("child_process");
var fs = require("fs");
var os = require("os");
var path = require("path");

var repoRoot = path.resolve(__dirname, "..");
var rushConfig = require(path.join(repoRoot, "rush.json"));
var rushRoot = path.join(repoRoot, "common", "temp", "install-run", "@microsoft+rush@" + rushConfig.rushVersion);
var pnpmModulesRoot = path.join(
    repoRoot,
    "common",
    "temp",
    "pnpm-local",
    "node_modules",
    "pnpm",
    "dist",
    "node_modules"
);
var patchRoot = path.join(os.tmpdir(), "applicationinsights-rush-toolchain-" + process.pid);

function getNpmCli() {
    var candidates = [
        process.env.npm_execpath,
        path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
        path.resolve(path.dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js")
    ];

    for (var lp = 0; lp < candidates.length; lp++) {
        if (candidates[lp] && fs.existsSync(candidates[lp])) {
            return candidates[lp];
        }
    }

    throw new Error("Unable to locate npm-cli.js");
}

function runNpm(args, cwd) {
    var result = childProcess.spawnSync(process.execPath, [getNpmCli()].concat(args), {
        cwd,
        encoding: "utf8",
        stdio: "inherit"
    });

    if (result.error) {
        throw result.error;
    }

    if (result.status !== 0) {
        throw new Error("npm " + args.join(" ") + " failed with exit code " + result.status);
    }
}

function getRegistryArgs() {
    var npmrcPath = path.join(repoRoot, "common", "temp", ".npmrc");
    if (fs.existsSync(npmrcPath)) {
        var match = fs.readFileSync(npmrcPath, "utf8").match(/^registry=(.+)$/m);
        if (match) {
            return ["--registry", match[1].trim()];
        }
    }

    return [];
}

function getPackageVersion(packagePath) {
    return JSON.parse(fs.readFileSync(path.join(packagePath, "package.json"), "utf8")).version;
}

if (!fs.existsSync(rushRoot)) {
    throw new Error("Rush bootstrap folder was not found: " + rushRoot);
}

if (!fs.existsSync(pnpmModulesRoot)) {
    throw new Error("pnpm bundled modules folder was not found: " + pnpmModulesRoot);
}

runNpm(["pkg", "set", "overrides.js-yaml=4.3.2"], rushRoot);
runNpm(["install", "--ignore-scripts", "--no-audit", "--no-fund"], rushRoot);

fs.rmSync(patchRoot, { force: true, recursive: true });
try {
    runNpm([
        "install",
        "--prefix", patchRoot,
        "--ignore-scripts",
        "--no-package-lock",
        "--no-audit",
        "--no-fund"
    ].concat(getRegistryArgs(), [
        "tar@7.5.22"
    ]), repoRoot);

    var source = path.join(patchRoot, "node_modules", "tar");
    var destination = path.join(pnpmModulesRoot, "tar");
    fs.rmSync(destination, { force: true, recursive: true });
    fs.cpSync(source, destination, { recursive: true });
} finally {
    fs.rmSync(patchRoot, { force: true, recursive: true });
}

var jsYamlVersion = getPackageVersion(path.join(rushRoot, "node_modules", "js-yaml"));
var tarVersion = getPackageVersion(path.join(pnpmModulesRoot, "tar"));
if (jsYamlVersion !== "4.3.2" || tarVersion !== "7.5.22") {
    throw new Error("Rush toolchain remediation failed: js-yaml=" + jsYamlVersion + ", tar=" + tarVersion);
}

console.log("Rush toolchain remediation complete: js-yaml=" + jsYamlVersion + ", tar=" + tarVersion);
