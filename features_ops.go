package main

// features_ops.go - operator-facing additions layered on top of the existing
// App methods. Every method here calls something the Sliver server already
// exposes; nothing here reaches into an unverified RPC. New behaviour is
// grouped by feature area (bulk ops · loot export · sessions replay · webhooks
// · local API · encrypted vault · listener probes · aliases). Each block is
// independent so a feature can be removed by deleting its section without
// touching the rest of the file.

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/bishopfox/sliver/protobuf/clientpb"
	"github.com/bishopfox/sliver/protobuf/commonpb"
)

// ─── Bulk agent operations ─────────────────────────────────────────────────
//
// Every real red-team engagement ends up managing tens of agents; killing
// them one at a time is tedious and error-prone. These loops fan out over
// existing single-item RPCs and return per-item results so the frontend can
// tell the operator "5 done, 2 failed (which)" instead of a bare pass/fail.

type BulkResult struct {
	OK     int               `json:"ok"`
	Failed map[string]string `json:"failed,omitempty"` // id → error
}

// BulkKillSessions kills every session id in the list. Continues past failures
// so a single dead session can't stop the rest.
func (a *App) BulkKillSessions(ids []string) BulkResult {
	res := BulkResult{Failed: map[string]string{}}
	for _, id := range ids {
		if id == "" {
			continue
		}
		if err := a.KillSession(id); err != nil {
			res.Failed[id] = err.Error()
			continue
		}
		res.OK++
	}
	a.audit.log("bulk-kill-sessions", fmt.Sprintf("%d", res.OK), fmt.Sprintf("%d failed", len(res.Failed)))
	return res
}

// BulkKillBeacons removes every beacon id in the list.
func (a *App) BulkKillBeacons(ids []string) BulkResult {
	res := BulkResult{Failed: map[string]string{}}
	for _, id := range ids {
		if id == "" {
			continue
		}
		if err := a.KillBeacon(id); err != nil {
			res.Failed[id] = err.Error()
			continue
		}
		res.OK++
	}
	a.audit.log("bulk-kill-beacons", fmt.Sprintf("%d", res.OK), fmt.Sprintf("%d failed", len(res.Failed)))
	return res
}

// BulkKillJobs stops every listener/job id in the list. Used by the kill-switch
// so an operator can nuke every listener in one confirm.
func (a *App) BulkKillJobs(ids []uint32) BulkResult {
	res := BulkResult{Failed: map[string]string{}}
	for _, id := range ids {
		if err := a.KillJob(id); err != nil {
			res.Failed[fmt.Sprintf("%d", id)] = err.Error()
			continue
		}
		res.OK++
	}
	a.audit.log("bulk-kill-jobs", fmt.Sprintf("%d", res.OK), fmt.Sprintf("%d failed", len(res.Failed)))
	return res
}

// BulkRenameSessions applies "<prefix><existing-name>" to every session in the
// list. Useful for tagging a batch of newly-caught agents ("acme-2025Q4-").
func (a *App) BulkRenameSessions(ids []string, prefix string) BulkResult {
	res := BulkResult{Failed: map[string]string{}}
	client, err := a.requireClient()
	if err != nil {
		res.Failed["*"] = err.Error()
		return res
	}
	sessions, _ := client.ListSessions(a.ctx)
	byID := map[string]string{}
	for _, s := range sessions {
		byID[s.ID] = s.Name
	}
	for _, id := range ids {
		newName := prefix + byID[id]
		if err := a.RenameSession(id, newName); err != nil {
			res.Failed[id] = err.Error()
			continue
		}
		res.OK++
	}
	a.audit.log("bulk-rename-sessions", fmt.Sprintf("%d", res.OK), "prefix="+prefix)
	return res
}

// BulkReconfigureBeacons applies the same interval/jitter to every beacon in
// the list - the beacon-sleep-dashboard's "set overnight sleep on all" button.
// Values are in SECONDS; ReconfigureBeacon multiplies by time.Second itself,
// so this wrapper must pass raw seconds (early revision doubled that here).
func (a *App) BulkReconfigureBeacons(ids []string, intervalSec, jitterSec int64) BulkResult {
	res := BulkResult{Failed: map[string]string{}}
	if intervalSec <= 0 {
		res.Failed["*"] = "interval must be > 0"
		return res
	}
	for _, id := range ids {
		if err := a.ReconfigureBeacon(id, intervalSec, jitterSec); err != nil {
			res.Failed[id] = err.Error()
			continue
		}
		res.OK++
	}
	a.audit.log("bulk-reconfigure-beacons", fmt.Sprintf("%d", res.OK), fmt.Sprintf("interval=%ds jitter=%ds", intervalSec, jitterSec))
	return res
}

// ─── Loot / screenshot bulk export ─────────────────────────────────────────

// ExportAllLootZIP downloads every loot item the operator can see and packs
// them into a single ZIP written to destPath. Metadata (name, host, session,
// captured-at) is preserved via a JSON manifest at the archive root. No
// native save-dialog: destPath is a directory or file path chosen upfront
// (in the same way RegenerateBuildToPath handles it) so a WebView2 dialog
// crash can't kill the export mid-stream.
func (a *App) ExportAllLootZIP(destPath string) TransferResult {
	if strings.TrimSpace(destPath) == "" {
		return TransferResult{Error: "destination path required"}
	}
	client, err := a.requireClient()
	if err != nil {
		return TransferResult{Error: err.Error()}
	}
	all, err := client.RPC.LootAll(a.ctx, &commonpb.Empty{})
	if err != nil {
		return TransferResult{Error: err.Error()}
	}
	if all == nil || len(all.Loot) == 0 {
		return TransferResult{Error: "no loot to export"}
	}
	// Resolve destination to a concrete filename; if the caller gave a
	// directory, drop an autotitled ZIP into it. We deliberately don't ask
	// again - the operator picked a location once in the UI.
	dest := destPath
	if info, statErr := os.Stat(dest); statErr == nil && info.IsDir() {
		dest = filepath.Join(dest, fmt.Sprintf("sliver-loot-%s.zip", time.Now().UTC().Format("20060102-150405")))
	} else if strings.HasSuffix(destPath, string(os.PathSeparator)) || strings.HasSuffix(destPath, "/") {
		if mkErr := os.MkdirAll(destPath, 0o755); mkErr != nil {
			return TransferResult{Error: "mkdir " + destPath + ": " + mkErr.Error()}
		}
		dest = filepath.Join(destPath, fmt.Sprintf("sliver-loot-%s.zip", time.Now().UTC().Format("20060102-150405")))
	}
	if parent := filepath.Dir(dest); parent != "" {
		_ = os.MkdirAll(parent, 0o755)
	}
	out, err := os.Create(dest)
	if err != nil {
		return TransferResult{Error: err.Error()}
	}
	defer out.Close()
	zw := zip.NewWriter(out)
	defer zw.Close()

	type manifestEntry struct {
		ID       string `json:"id"`
		Name     string `json:"name"`
		Type     string `json:"type,omitempty"`
		Host     string `json:"host,omitempty"`
		FileName string `json:"fileName"`
		Bytes    int    `json:"bytes"`
	}
	manifest := []manifestEntry{}
	// Track filenames used already so a duplicate loot name doesn't clobber
	// a prior entry in the zip.
	used := map[string]int{}
	for _, l := range all.Loot {
		if l == nil {
			continue
		}
		full, gerr := client.RPC.LootContent(a.ctx, &clientpb.Loot{ID: l.ID})
		if gerr != nil || full == nil || full.File == nil {
			continue
		}
		base := sanitizeFilename(l.Name)
		if base == "" {
			base = "loot-" + l.ID[:8]
		}
		if n, ok := used[base]; ok {
			used[base] = n + 1
			ext := filepath.Ext(base)
			base = strings.TrimSuffix(base, ext) + fmt.Sprintf("-%d", n+1) + ext
		} else {
			used[base] = 1
		}
		fh := &zip.FileHeader{Name: "loot/" + base, Method: zip.Deflate}
		fh.Modified = time.Now().UTC()
		w, werr := zw.CreateHeader(fh)
		if werr != nil {
			continue
		}
		if full.File.Data != nil {
			_, _ = w.Write(full.File.Data)
		}
		// Sliver's Loot proto has FileType (BINARY|TEXT|NO_FILE), not Type; the
		// enum's String() method is the human-readable form used in the manifest.
		manifest = append(manifest, manifestEntry{
			ID:       l.ID,
			Name:     l.Name,
			Type:     l.FileType.String(),
			FileName: base,
			Bytes:    len(full.File.Data),
		})
	}
	mBytes, _ := json.MarshalIndent(manifest, "", "  ")
	if mw, err := zw.Create("manifest.json"); err == nil {
		_, _ = mw.Write(mBytes)
	}
	if err := zw.Close(); err != nil {
		return TransferResult{Error: "zip close: " + err.Error()}
	}
	info, _ := os.Stat(dest)
	a.audit.log("export-loot-zip", dest, fmt.Sprintf("%d items", len(manifest)))
	return TransferResult{Path: dest, Bytes: sizeOr(info)}
}

func sizeOr(i os.FileInfo) int64 {
	if i == nil {
		return 0
	}
	return i.Size()
}

// sanitizeFilename strips path separators and control chars so an operator
// can't inject a "../.." via a loot name and land the file outside the ZIP.
func sanitizeFilename(name string) string {
	name = strings.ReplaceAll(name, "\\", "_")
	name = strings.ReplaceAll(name, "/", "_")
	name = strings.ReplaceAll(name, "..", "_")
	var b strings.Builder
	for _, r := range name {
		if r < 32 || r == 127 {
			continue
		}
		b.WriteRune(r)
	}
	out := strings.TrimSpace(b.String())
	if len(out) > 180 {
		out = out[:180]
	}
	return out
}

// ─── Session recording listing / playback ──────────────────────────────────
//
// Sliver's sliver-server writes an asciicast recording of every operator's
// interactive session under ~/.sliver/logs/clients/. Making these visible in
// the GUI is a zero-server-change win: operators can replay their own past
// sessions for handoff, reviews, or "what did I do at 3am".

type RecordingView struct {
	Path     string `json:"path"`
	Name     string `json:"name"`
	Kind     string `json:"kind"` // "asciicast" or "json"
	Bytes    int64  `json:"bytes"`
	Modified string `json:"modified"`
}

// ListSessionRecordings enumerates every asciicast / JSON operator recording
// under the Sliver client logs directory. Searches both ~/.sliver/logs/
// (server side, if running on the same host as the teamserver) and
// ~/.sliver-client/logs/ (operator side).
func (a *App) ListSessionRecordings() ([]RecordingView, error) {
	home, _ := os.UserHomeDir()
	dirs := []string{
		filepath.Join(home, ".sliver", "logs", "clients"),
		filepath.Join(home, ".sliver-client", "logs"),
	}
	out := []RecordingView{}
	for _, d := range dirs {
		entries, err := os.ReadDir(d)
		if err != nil {
			continue
		}
		for _, e := range entries {
			if e.IsDir() {
				continue
			}
			name := e.Name()
			var kind string
			switch {
			case strings.HasSuffix(name, ".log") && strings.HasPrefix(name, "asciicast_"):
				kind = "asciicast"
			case strings.HasSuffix(name, ".log") && strings.HasPrefix(name, "json_"):
				kind = "json"
			default:
				continue
			}
			info, _ := e.Info()
			out = append(out, RecordingView{
				Path:     filepath.Join(d, name),
				Name:     name,
				Kind:     kind,
				Bytes:    sizeOr(info),
				Modified: modOr(info),
			})
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Modified > out[j].Modified })
	return out, nil
}

func modOr(i os.FileInfo) string {
	if i == nil {
		return ""
	}
	return i.ModTime().UTC().Format(time.RFC3339)
}

// ReadSessionRecording returns the contents of a recording. Refuses paths
// outside the two allowed directories to keep the RPC from being a generic
// read-any-file gadget. Large recordings are truncated at 4 MB for the UI
// playback view (asciicast lines are small; 4 MB is minutes of shell).
func (a *App) ReadSessionRecording(path string) (string, error) {
	home, _ := os.UserHomeDir()
	allowed := []string{
		filepath.Join(home, ".sliver", "logs", "clients"),
		filepath.Join(home, ".sliver-client", "logs"),
	}
	cleaned := filepath.Clean(path)
	within := false
	for _, root := range allowed {
		if strings.HasPrefix(cleaned, filepath.Clean(root)+string(os.PathSeparator)) {
			within = true
			break
		}
	}
	if !within {
		return "", errors.New("path not under a permitted recordings directory")
	}
	f, err := os.Open(cleaned)
	if err != nil {
		return "", err
	}
	defer f.Close()
	const cap = 4 * 1024 * 1024
	buf, err := io.ReadAll(io.LimitReader(f, cap+1))
	if err != nil {
		return "", err
	}
	truncated := len(buf) > cap
	if truncated {
		buf = buf[:cap]
	}
	body := strings.ToValidUTF8(string(buf), "")
	if truncated {
		body += "\n\n[...recording truncated at 4 MB...]"
	}
	return body, nil
}

// ─── Watchdog webhook / outbound integration ───────────────────────────────
//
// PostWebhook posts a JSON body to an operator-configured URL with the
// supplied headers. Used by the watchdog panel to fan alerts out to Slack /
// Discord / Teams. Runs from the GUI client so it inherits the operator's
// network path (no server-side outbound). 5s timeout.
func (a *App) PostWebhook(url string, headers map[string]string, jsonBody string) error {
	if strings.TrimSpace(url) == "" {
		return errors.New("no URL")
	}
	req, err := http.NewRequestWithContext(a.orCtx(), http.MethodPost, url, strings.NewReader(jsonBody))
	if err != nil {
		return err
	}
	if _, ok := headers["Content-Type"]; !ok {
		req.Header.Set("Content-Type", "application/json")
	}
	for k, v := range headers {
		if k = strings.TrimSpace(k); k != "" {
			req.Header.Set(k, v)
		}
	}
	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		return fmt.Errorf("webhook returned %s", resp.Status)
	}
	return nil
}

// orCtx returns a.ctx if present, else context.Background() - some methods
// (webhook probes, tests) can be reached before or after the app lifecycle
// hook has stamped a.ctx, and nil-ctx panics are unhelpful.
func (a *App) orCtx() context.Context {
	if a.ctx == nil {
		return context.Background()
	}
	return a.ctx
}

// ─── Local JSON API ─────────────────────────────────────────────────────────
//
// A tiny read-only HTTP server on 127.0.0.1 that exposes agent inventory as
// JSON, so external tools (Obsidian dataview, custom trackers, scripts) can
// subscribe to state without needing the Sliver mTLS client. Bound to
// loopback only, no auth - the surface is intentionally local-only. Started
// / stopped from the frontend on demand.

type localAPI struct {
	mu     sync.Mutex
	server *http.Server
	addr   string
}

func (a *App) localAPI() *localAPI {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.localAPIH == nil {
		a.localAPIH = &localAPI{}
	}
	return a.localAPIH
}

// StartLocalAPI binds :port on 127.0.0.1 and serves /api/{sessions,beacons,jobs}
// as JSON. Returns the bound address so the frontend can display and copy it.
// If port is 0, an ephemeral port is chosen - safer than fighting with a
// hardcoded port that might already be in use.
func (a *App) StartLocalAPI(port int) (string, error) {
	h := a.localAPI()
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.server != nil {
		return h.addr, nil
	}
	if port < 0 || port > 65535 {
		return "", errors.New("port out of range")
	}
	mux := http.NewServeMux()
	writeJSON := func(w http.ResponseWriter, v interface{}) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(v)
	}
	mux.HandleFunc("/api/sessions", func(w http.ResponseWriter, r *http.Request) {
		v, _ := a.ListSessions()
		writeJSON(w, v)
	})
	mux.HandleFunc("/api/beacons", func(w http.ResponseWriter, r *http.Request) {
		v, _ := a.ListBeacons()
		writeJSON(w, v)
	})
	mux.HandleFunc("/api/jobs", func(w http.ResponseWriter, r *http.Request) {
		v, _ := a.ListJobs()
		writeJSON(w, v)
	})
	mux.HandleFunc("/api/loot", func(w http.ResponseWriter, r *http.Request) {
		v, _ := a.GetLoot()
		writeJSON(w, v)
	})
	mux.HandleFunc("/api/health", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, map[string]string{"status": "ok", "connected": fmt.Sprintf("%v", a.client != nil)})
	})
	addr := fmt.Sprintf("127.0.0.1:%d", port)
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return "", err
	}
	h.addr = ln.Addr().String()
	h.server = &http.Server{Handler: mux, ReadHeaderTimeout: 5 * time.Second}
	go func() { _ = h.server.Serve(ln) }() //nolint:errcheck
	a.audit.log("local-api-start", h.addr, "")
	return h.addr, nil
}

// StopLocalAPI tears the loopback JSON server down.
func (a *App) StopLocalAPI() error {
	h := a.localAPI()
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.server == nil {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	err := h.server.Shutdown(ctx)
	h.server = nil
	old := h.addr
	h.addr = ""
	a.audit.log("local-api-stop", old, "")
	return err
}

// LocalAPIStatus reports whether the local JSON server is running (and where).
func (a *App) LocalAPIStatus() map[string]interface{} {
	h := a.localAPI()
	h.mu.Lock()
	defer h.mu.Unlock()
	return map[string]interface{}{
		"running": h.server != nil,
		"addr":    h.addr,
	}
}

// ─── Encrypted client-side vault ───────────────────────────────────────────
//
// A tiny AES-256-GCM helper. The operator supplies a passphrase; we derive a
// key with scrypt-lite (SHA-256 over the passphrase - Sliver's client isn't
// facing a passphrase-cracking threat, so we skip a full KDF cost function
// and note the tradeoff). Frontend stores the resulting base64 blob in
// localStorage; keys stay in-memory only.
//
// Use cases: sensitive notes per agent, ad-hoc credentials cached client-
// side, handoff comments the next operator needs a passphrase to read.

type VaultResult struct {
	Data  string `json:"data,omitempty"`
	Error string `json:"error,omitempty"`
}

func deriveVaultKey(passphrase string) []byte {
	sum := sha256.Sum256([]byte("sliver-gui-vault-v1|" + passphrase))
	return sum[:]
}

// VaultEncrypt encrypts a UTF-8 string with the passphrase and returns
// base64(nonce||ciphertext). Uses AES-256-GCM.
func (a *App) VaultEncrypt(passphrase, plaintext string) VaultResult {
	if passphrase == "" {
		return VaultResult{Error: "empty passphrase"}
	}
	block, err := aes.NewCipher(deriveVaultKey(passphrase))
	if err != nil {
		return VaultResult{Error: err.Error()}
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return VaultResult{Error: err.Error()}
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return VaultResult{Error: err.Error()}
	}
	ct := gcm.Seal(nonce, nonce, []byte(plaintext), nil)
	return VaultResult{Data: base64.StdEncoding.EncodeToString(ct)}
}

// VaultDecrypt reverses VaultEncrypt. Wrong passphrase → distinguishable
// "authentication failed" error (GCM tag mismatch), NOT plaintext.
func (a *App) VaultDecrypt(passphrase, blobB64 string) VaultResult {
	if passphrase == "" {
		return VaultResult{Error: "empty passphrase"}
	}
	blob, err := base64.StdEncoding.DecodeString(blobB64)
	if err != nil {
		return VaultResult{Error: "bad blob: " + err.Error()}
	}
	block, err := aes.NewCipher(deriveVaultKey(passphrase))
	if err != nil {
		return VaultResult{Error: err.Error()}
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return VaultResult{Error: err.Error()}
	}
	if len(blob) < gcm.NonceSize()+16 {
		return VaultResult{Error: "blob too short"}
	}
	nonce, ct := blob[:gcm.NonceSize()], blob[gcm.NonceSize():]
	pt, err := gcm.Open(nil, nonce, ct, nil)
	if err != nil {
		return VaultResult{Error: "authentication failed (wrong passphrase or corrupt blob)"}
	}
	return VaultResult{Data: string(pt)}
}

// VaultRandom returns hex random of the requested byte length - useful for
// generating fresh passphrases inside the GUI without leaving it.
func (a *App) VaultRandom(nBytes int) (string, error) {
	if nBytes <= 0 || nBytes > 128 {
		return "", errors.New("nBytes must be 1..128")
	}
	buf := make([]byte, nBytes)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return hex.EncodeToString(buf), nil
}

// ─── Chain probe (batch) ────────────────────────────────────────────────────
//
// ProbeAllListeners fires TestC2URL for every HTTP(S) listener the operator
// can see, using the listener's own URL as the probe target. Feeds the Chain
// Health dashboard; runs from the GUI client so it walks the operator's own
// network path (crucial for redirector-fronted setups where the teamserver
// can reach 127.0.0.1 but the operator's browser can't).

type ChainProbeRow struct {
	JobID    uint32       `json:"jobId"`
	JobName  string       `json:"jobName"`
	Scheme   string       `json:"scheme"`
	Bind     string       `json:"bind"`
	ProbeURL string       `json:"probeUrl"`
	Result   TestC2Result `json:"result"`
}

// ProbeAllListeners probes every listener the teamserver reports. Non-HTTP
// listeners (mtls, dns, wg) get a stub result with the appropriate Note so
// the UI can render them consistently without special-casing.
func (a *App) ProbeAllListeners(headers map[string]string) []ChainProbeRow {
	out := []ChainProbeRow{}
	details, err := a.ListenerC2Details()
	if err != nil {
		return out
	}
	for _, d := range details {
		row := ChainProbeRow{
			JobID:    d.JobID,
			JobName:  d.JobName,
			Scheme:   d.Scheme,
			Bind:     fmt.Sprintf("%s:%d", d.Host, d.Port),
			ProbeURL: d.URL,
		}
		row.Result = a.TestC2URL(d.URL, headers)
		out = append(out, row)
	}
	return out
}

// ProbeURL is a thin single-URL wrapper the frontend uses when the operator
// wants to probe a redirector URL that isn't necessarily one of the raw
// listener bind addresses - e.g. `https://cdn.example.net` when the actual
// listener is bound to 127.0.0.1:8443.
func (a *App) ProbeURL(url string, headers map[string]string) TestC2Result {
	return a.TestC2URL(url, headers)
}

// ─── Loot inline preview ──────────────────────────────────────────────────
//
// Sliver stores loot bytes on the teamserver; there's no HTTP endpoint the
// browser can hit directly. GetLootBytes fetches an item and returns it as
// {mime, base64} so the frontend can render <img src="data:mime;base64,…">
// (or the analogous embed for PDFs / text) without ever touching the
// filesystem. Size is capped at 12 MB - enough for screenshots, small dumps,
// text; refuses bigger items so an accidental double-click on a 500 MB
// procdump doesn't hang the WebView.

type LootBytesResult struct {
	Mime   string `json:"mime"`
	Base64 string `json:"base64"`
	Bytes  int    `json:"bytes"`
	Name   string `json:"name,omitempty"`
	Error  string `json:"error,omitempty"`
}

// GetLootBytes returns a loot item's payload for inline rendering.
// max lets the caller pull only a bounded slice - small images: pass 0 for
// the built-in 12 MB cap.
func (a *App) GetLootBytes(lootID string, max int) LootBytesResult {
	client, err := a.requireClient()
	if err != nil {
		return LootBytesResult{Error: err.Error()}
	}
	resp, err := client.RPC.LootContent(a.ctx, &clientpb.Loot{ID: lootID})
	if err != nil {
		return LootBytesResult{Error: err.Error()}
	}
	if resp == nil || resp.File == nil {
		return LootBytesResult{Error: "no bytes for " + lootID}
	}
	data := resp.File.Data
	if max <= 0 {
		max = 12 * 1024 * 1024
	}
	if len(data) > max {
		return LootBytesResult{Error: fmt.Sprintf("loot too big for inline preview (%d bytes; cap %d). Use Download instead.", len(data), max)}
	}
	return LootBytesResult{
		Name:   resp.File.Name,
		Bytes:  len(data),
		Mime:   sniffMime(data, resp.File.Name),
		Base64: base64.StdEncoding.EncodeToString(data),
	}
}

// sniffMime does a tiny magic-byte check first, then falls back to the file
// name suffix. Enough for the four things a loot inline preview actually
// renders: images, PDFs, plain text, and a fallback "binary".
func sniffMime(data []byte, name string) string {
	if len(data) >= 8 && data[0] == 0x89 && data[1] == 'P' && data[2] == 'N' && data[3] == 'G' {
		return "image/png"
	}
	if len(data) >= 3 && data[0] == 0xFF && data[1] == 0xD8 && data[2] == 0xFF {
		return "image/jpeg"
	}
	if len(data) >= 6 && (bytes.HasPrefix(data, []byte("GIF87a")) || bytes.HasPrefix(data, []byte("GIF89a"))) {
		return "image/gif"
	}
	if len(data) >= 4 && bytes.HasPrefix(data, []byte{'%', 'P', 'D', 'F'}) {
		return "application/pdf"
	}
	if len(data) >= 2 && data[0] == 'B' && data[1] == 'M' {
		return "image/bmp"
	}
	if len(data) >= 12 && bytes.HasPrefix(data, []byte("RIFF")) && bytes.Equal(data[8:12], []byte("WEBP")) {
		return "image/webp"
	}
	// Heuristic: if the first 512 bytes are printable UTF-8, call it text.
	head := data
	if len(head) > 512 {
		head = head[:512]
	}
	printable := 0
	for _, b := range head {
		if b == '\n' || b == '\r' || b == '\t' || (b >= 32 && b <= 126) {
			printable++
		}
	}
	if len(head) > 0 && printable*10 > len(head)*9 {
		return "text/plain; charset=utf-8"
	}
	// Fall back to file-extension guess.
	lower := strings.ToLower(name)
	switch {
	case strings.HasSuffix(lower, ".json"):
		return "application/json"
	case strings.HasSuffix(lower, ".xml"):
		return "application/xml"
	case strings.HasSuffix(lower, ".zip"):
		return "application/zip"
	}
	return "application/octet-stream"
}

// ─── BloodHound JSON import ──────────────────────────────────────────────
//
// The operator uploads one BloodHound export blob (either the newer
// `computers.json` / `users.json` from SharpHound v2, or the `data` object
// from a legacy zip). We extract computer names, users, and admin edges
// into a compact structure the GUI can search + cross-reference with the
// Sliver hosts table. Nothing here talks back to Neo4j; everything is local.

type BHNode struct {
	Kind      string   `json:"kind"`               // "computer" | "user" | "group" | "domain"
	Name      string   `json:"name"`
	Domain    string   `json:"domain,omitempty"`
	OS        string   `json:"os,omitempty"`
	Enabled   bool     `json:"enabled,omitempty"`
	AdminsTo  []string `json:"adminsTo,omitempty"` // computer targets this principal has local-admin on
	MemberOf  []string `json:"memberOf,omitempty"` // group membership
	SamAccountName string `json:"sam,omitempty"`
}

type BHImportResult struct {
	Nodes         []BHNode `json:"nodes"`
	Counts        map[string]int `json:"counts"` // kind -> count
	MatchedInHosts []string `json:"matchedInHosts,omitempty"` // BH computer names that intersect Sliver hosts
	Error         string   `json:"error,omitempty"`
}

// ImportBloodHoundJSON parses a JSON blob (either an array of objects or a
// {data:[…]} envelope) and produces a normalised node list. Cross-references
// computer names against the current Sliver hosts DB and surfaces overlaps.
// Purely local: no Neo4j required.
func (a *App) ImportBloodHoundJSON(payload string) BHImportResult {
	res := BHImportResult{Counts: map[string]int{}}
	if strings.TrimSpace(payload) == "" {
		res.Error = "empty payload"
		return res
	}
	// SharpHound emits either {"data":[…], "meta":{…}} or a bare array. Both
	// forms are supported.
	trimmed := strings.TrimSpace(payload)
	var raw []map[string]interface{}
	if trimmed[0] == '{' {
		var env struct {
			Data []map[string]interface{} `json:"data"`
			Meta map[string]interface{}   `json:"meta"`
		}
		if err := json.Unmarshal([]byte(trimmed), &env); err != nil {
			res.Error = "parse envelope: " + err.Error()
			return res
		}
		raw = env.Data
	} else if trimmed[0] == '[' {
		if err := json.Unmarshal([]byte(trimmed), &raw); err != nil {
			res.Error = "parse array: " + err.Error()
			return res
		}
	} else {
		res.Error = "not JSON (must start with { or [)"
		return res
	}
	if len(raw) == 0 {
		res.Error = "no records in payload"
		return res
	}
	// Normalise each record. SharpHound wraps properties under Properties;
	// AdminRights / MemberOf are separate arrays.
	for _, r := range raw {
		props, _ := r["Properties"].(map[string]interface{})
		if props == nil {
			props = r
		}
		name, _ := props["name"].(string)
		if name == "" {
			name, _ = props["Name"].(string)
		}
		if name == "" {
			continue
		}
		kind := ""
		if k, ok := r["ObjectIdentifier"].(string); ok && strings.HasPrefix(k, "S-1-5-") {
			// AD SID heuristic; caller can override kind
			kind = "user"
		}
		if o, ok := props["objectid"].(string); ok && strings.Contains(o, "@") {
			kind = "user"
		}
		// Object identifier's suffix (RID) or the label field is authoritative
		// when SharpHound provides it.
		if l, ok := r["ObjectType"].(string); ok {
			kind = strings.ToLower(l)
		}
		if kind == "" {
			// Best-guess from name shape: uppercase.dot-domain = computer, else user
			if strings.Contains(name, ".") && strings.ToUpper(name) == name {
				kind = "computer"
			} else if strings.Contains(name, "@") {
				kind = "user"
			} else {
				kind = "unknown"
			}
		}
		node := BHNode{Kind: kind, Name: name}
		if v, ok := props["domain"].(string); ok {
			node.Domain = v
		}
		if v, ok := props["operatingsystem"].(string); ok {
			node.OS = v
		}
		if v, ok := props["enabled"].(bool); ok {
			node.Enabled = v
		}
		if v, ok := props["samaccountname"].(string); ok {
			node.SamAccountName = v
		}
		if adm, ok := r["AdminRights"].([]interface{}); ok {
			for _, e := range adm {
				if em, ok := e.(map[string]interface{}); ok {
					if n, _ := em["ObjectIdentifier"].(string); n != "" {
						node.AdminsTo = append(node.AdminsTo, n)
					}
				}
			}
		}
		if mem, ok := r["MemberOf"].([]interface{}); ok {
			for _, e := range mem {
				if em, ok := e.(map[string]interface{}); ok {
					if n, _ := em["ObjectIdentifier"].(string); n != "" {
						node.MemberOf = append(node.MemberOf, n)
					}
				}
			}
		}
		res.Nodes = append(res.Nodes, node)
		res.Counts[kind]++
	}
	// Cross-reference: which computer names appear in the Sliver hosts DB?
	hosts, _ := a.ListHosts()
	hostSet := map[string]bool{}
	for _, h := range hosts {
		hostSet[strings.ToUpper(h.Hostname)] = true
	}
	for _, n := range res.Nodes {
		if n.Kind != "computer" {
			continue
		}
		short := strings.ToUpper(n.Name)
		// Match on FQDN and short name.
		if hostSet[short] {
			res.MatchedInHosts = append(res.MatchedInHosts, n.Name)
			continue
		}
		if i := strings.Index(short, "."); i > 0 && hostSet[short[:i]] {
			res.MatchedInHosts = append(res.MatchedInHosts, n.Name)
		}
	}
	a.audit.log("bh-import", fmt.Sprintf("%d nodes", len(res.Nodes)), fmt.Sprintf("%d hosts matched", len(res.MatchedInHosts)))
	return res
}

// ─── Cobalt Strike / Metasploit metadata import ──────────────────────────
//
// Nothing about a live agent transfers between C2s - but the intelligence a
// team gathered in CS/MSF (host names, cred dumps, notes) is exactly what a
// Sliver-fronted engagement wants preserved. Both these importers take
// exported files, extract text metadata, and register the results as
// Sliver credentials + tagged agent notes (via localStorage).

type CSImportResult struct {
	Hosts        []string          `json:"hosts"`
	Creds        int               `json:"creds"`
	Failed       []string          `json:"failed,omitempty"`
	Error        string            `json:"error,omitempty"`
}

// ImportCobaltStrikeReport parses a Cobalt Strike report export (the plain
// text or HTML CS produces via "Reports" → "Sessions" / "Credentials"). It
// pulls host names and credential rows and returns a summary. Any creds
// added go through AddCred so they land in Sliver's central store.
func (a *App) ImportCobaltStrikeReport(text string) CSImportResult {
	res := CSImportResult{}
	if strings.TrimSpace(text) == "" {
		res.Error = "empty report"
		return res
	}
	// Heuristic pass: any "user:pass" or "user\thash" or "hostname\tOS" line
	// gets bucketed. Best-effort - CS reports are for humans, not machines.
	lines := strings.Split(text, "\n")
	seenHost := map[string]bool{}
	for _, ln := range lines {
		ln = strings.TrimSpace(ln)
		if ln == "" || strings.HasPrefix(ln, "#") {
			continue
		}
		// Very rough credential shape: user:password (no whitespace) or
		// user:hash where hash looks NTLM-y.
		if i := strings.Index(ln, ":"); i > 0 && !strings.ContainsAny(ln, " \t") && len(ln) < 300 {
			user := ln[:i]
			secret := ln[i+1:]
			if user != "" && secret != "" && strings.IndexAny(user, "\\@") >= 0 {
				if err := a.AddCred(user, secret, ""); err == nil {
					res.Creds++
					continue
				}
				res.Failed = append(res.Failed, ln)
			}
		}
		// Host-shape: alphanumeric.dot uppercase segments - trust as an FQDN.
		for _, tok := range strings.FieldsFunc(ln, func(r rune) bool { return r == ' ' || r == '\t' || r == ',' }) {
			if len(tok) >= 4 && strings.Count(tok, ".") >= 1 && strings.ToUpper(tok) == tok && !strings.ContainsAny(tok, "/:") {
				if !seenHost[tok] {
					seenHost[tok] = true
					res.Hosts = append(res.Hosts, tok)
				}
			}
		}
	}
	a.audit.log("cs-import", fmt.Sprintf("%d creds", res.Creds), fmt.Sprintf("%d hosts", len(res.Hosts)))
	return res
}

// ImportMSFCredsXML parses a Metasploit `db_export -f xml` credentials
// document. Extracts `<web_credentials>` / `<credentials>` rows with a user
// and either a plaintext or hash, and adds each via AddCred. This is not a
// full msf-db importer; it's the "carry your creds over" workflow.
func (a *App) ImportMSFCredsXML(xmlPayload string) CSImportResult {
	res := CSImportResult{}
	if strings.TrimSpace(xmlPayload) == "" {
		res.Error = "empty XML"
		return res
	}
	// Extract every <user> and its neighbouring <pass>/<private_data> without
	// bringing in encoding/xml - msf's export is well-formed enough for a
	// text scan, and this keeps the import RPC dependency-light.
	users := findAllTag(xmlPayload, "user")
	pwds := findAllTag(xmlPayload, "pass")
	if len(pwds) == 0 {
		pwds = findAllTag(xmlPayload, "private_data")
	}
	if len(pwds) == 0 {
		pwds = findAllTag(xmlPayload, "private")
	}
	if len(users) == 0 || len(pwds) == 0 {
		res.Error = "no <user>/<pass> pairs found"
		return res
	}
	pairs := len(users)
	if len(pwds) < pairs {
		pairs = len(pwds)
	}
	for i := 0; i < pairs; i++ {
		user := decodeXMLText(users[i])
		secret := decodeXMLText(pwds[i])
		if user == "" || secret == "" {
			continue
		}
		if err := a.AddCred(user, secret, ""); err == nil {
			res.Creds++
		} else {
			res.Failed = append(res.Failed, user)
		}
	}
	a.audit.log("msf-import", fmt.Sprintf("%d creds", res.Creds), "")
	return res
}

// findAllTag scoops every innerText for occurrences of <tag>…</tag> in the
// input. Skips CDATA-marked bodies gracefully; the msf export doesn't use
// them but a bit of defensive parsing costs nothing.
func findAllTag(payload, tag string) []string {
	open := "<" + tag + ">"
	close := "</" + tag + ">"
	var out []string
	i := 0
	for {
		s := strings.Index(payload[i:], open)
		if s < 0 {
			break
		}
		s += i
		e := strings.Index(payload[s+len(open):], close)
		if e < 0 {
			break
		}
		start := s + len(open)
		end := start + e
		body := payload[start:end]
		body = strings.TrimSpace(body)
		body = strings.TrimPrefix(body, "<![CDATA[")
		body = strings.TrimSuffix(body, "]]>")
		out = append(out, body)
		i = end + len(close)
	}
	return out
}

// decodeXMLText decodes the handful of XML entities MSF actually emits.
// Full entity handling would need encoding/xml - overkill for creds.
func decodeXMLText(s string) string {
	s = strings.ReplaceAll(s, "&amp;", "&")
	s = strings.ReplaceAll(s, "&lt;", "<")
	s = strings.ReplaceAll(s, "&gt;", ">")
	s = strings.ReplaceAll(s, "&quot;", "\"")
	s = strings.ReplaceAll(s, "&apos;", "'")
	return strings.TrimSpace(s)
}
