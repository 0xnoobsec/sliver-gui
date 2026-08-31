package main

import (
	"bytes"
	"compress/gzip"
	"testing"

	"github.com/bishopfox/sliver/protobuf/clientpb"
	"github.com/bishopfox/sliver/protobuf/sliverpb"
	"google.golang.org/protobuf/proto"
)

func TestRandSuffix(t *testing.T) {
	seen := map[string]bool{}
	for i := 0; i < 1000; i++ {
		s := randSuffix()
		if len(s) == 0 {
			t.Fatal("randSuffix returned empty string")
		}
		if seen[s] {
			t.Fatalf("randSuffix collision on %q within 1000 draws", s)
		}
		seen[s] = true
	}
}

func TestSchemeOf(t *testing.T) {
	cases := map[string]string{
		"https://1.2.3.4:8443": "https",
		"mtls://host:8888":     "mtls",
		"dns://example.com":    "dns",
		"1.2.3.4:8888":         "",
		"":                     "",
	}
	for in, want := range cases {
		if got := schemeOf(in); got != want {
			t.Errorf("schemeOf(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestFormatFromString(t *testing.T) {
	cases := map[string]clientpb.OutputFormat{
		"shared":    clientpb.OutputFormat_SHARED_LIB,
		"service":   clientpb.OutputFormat_SERVICE,
		"shellcode": clientpb.OutputFormat_SHELLCODE,
		"exe":       clientpb.OutputFormat_EXECUTABLE,
		"":          clientpb.OutputFormat_EXECUTABLE,
	}
	for in, want := range cases {
		if got := formatFromString(in); got != want {
			t.Errorf("formatFromString(%q) = %v, want %v", in, got, want)
		}
	}
}

func TestParseCSVLine(t *testing.T) {
	cases := []struct {
		in   string
		want []string
	}{
		{`a,b,c`, []string{"a", "b", "c"}},
		{`"a,b",c`, []string{"a,b", "c"}},
		{`"he said ""hi""",x`, []string{`he said "hi"`, "x"}},
		{``, []string{""}},
		{`,,`, []string{"", "", ""}},
	}
	for _, c := range cases {
		got := parseCSVLine(c.in)
		if len(got) != len(c.want) {
			t.Errorf("parseCSVLine(%q) len = %d, want %d (%q)", c.in, len(got), len(c.want), got)
			continue
		}
		for i := range got {
			if got[i] != c.want[i] {
				t.Errorf("parseCSVLine(%q)[%d] = %q, want %q", c.in, i, got[i], c.want[i])
			}
		}
	}
}

func TestParseExecuteResponse(t *testing.T) {
	// Empty -> placeholder.
	if out, _ := parseExecuteResponse(nil); out != "(no output)" {
		t.Errorf("empty response = %q, want (no output)", out)
	}
	// Valid protobuf round-trips stdout/stderr.
	data, err := proto.Marshal(&sliverpb.Execute{
		Stdout: []byte("hello"),
		Stderr: []byte("oops"),
	})
	if err != nil {
		t.Fatal(err)
	}
	out, errStr := parseExecuteResponse(data)
	if out != "hello" || errStr != "oops" {
		t.Errorf("parseExecuteResponse = (%q,%q), want (hello,oops)", out, errStr)
	}
}

func TestBuildImplantConfigRespectsOperatorProfile(t *testing.T) {
	// When the operator picks an HTTP C2 profile, that name must land in
	// cfg.HTTPC2ConfigName verbatim - otherwise the beacon uses the wrong
	// URIs/headers/UA and a redirector gated on a shared-secret header will
	// silently 401 every check-in.
	a := &App{}
	req := GenerateRequest{
		GOOS:          "windows",
		GOARCH:        "amd64",
		Format:        "exe",
		C2URL:         "https://cdn.example.net",
		HTTPC2Profile: "  my-header-profile  ", // whitespace-tolerant
	}
	cfg := a.buildImplantConfig(req)
	if cfg.HTTPC2ConfigName != "my-header-profile" {
		t.Errorf("HTTPC2ConfigName = %q, want %q", cfg.HTTPC2ConfigName, "my-header-profile")
	}
	if !cfg.IncludeHTTP {
		t.Errorf("IncludeHTTP not set for https scheme")
	}
}

func TestBuildImplantConfigFallsBackToDefault(t *testing.T) {
	// With no operator profile and no live client, the fallback must land on
	// "default" so the teamserver picks whatever it has. Guards against a nil-
	// deref regression if the fallback ever forgets to handle a nil client.
	a := &App{}
	req := GenerateRequest{
		GOOS:   "windows",
		GOARCH: "amd64",
		Format: "exe",
		C2URL:  "https://cdn.example.net",
	}
	cfg := a.buildImplantConfig(req)
	if cfg.HTTPC2ConfigName != "default" {
		t.Errorf("HTTPC2ConfigName = %q, want default", cfg.HTTPC2ConfigName)
	}
}

func TestTestC2URLRejectsBadInputs(t *testing.T) {
	// Empty/invalid URLs and non-HTTP schemes must return an actionable
	// message instead of silently hanging or panicking. We deliberately don't
	// exercise inputs like "host:8443" here - url.Parse is permissive enough
	// that the observed scheme depends on Go version, so the response is a
	// diagnostic Note rather than a hard Error, and we don't want to lock in
	// which branch fires for those edge cases.
	a := &App{}
	if r := a.TestC2URL("", nil); r.Error == "" {
		t.Error("empty URL should error")
	}
	if r := a.TestC2URL("http://%zz", nil); r.Error == "" {
		// %zz is an invalid percent-escape - url.Parse rejects it outright.
		t.Error("URL with invalid percent-escape should error")
	}
	if r := a.TestC2URL("mtls://host:8443", nil); r.Note == "" || r.Error != "" {
		t.Errorf("mtls scheme should return Note, got err=%q note=%q", r.Error, r.Note)
	}
	if r := a.TestC2URL("dns://example.com", nil); r.Note == "" || r.Error != "" {
		t.Errorf("dns scheme should return Note, got err=%q note=%q", r.Error, r.Note)
	}
}

func TestDecodeDownload(t *testing.T) {
	// Plain (no encoder) passes through.
	if got, err := decodeDownload(&sliverpb.Download{Data: []byte("raw")}); err != nil || string(got) != "raw" {
		t.Errorf("plain decode = (%q,%v), want (raw,nil)", got, err)
	}
	// gzip encoder is inflated.
	var buf bytes.Buffer
	zw := gzip.NewWriter(&buf)
	zw.Write([]byte("compressed payload"))
	zw.Close()
	got, err := decodeDownload(&sliverpb.Download{Encoder: "gzip", Data: buf.Bytes()})
	if err != nil || string(got) != "compressed payload" {
		t.Errorf("gzip decode = (%q,%v), want (compressed payload,nil)", got, err)
	}
}
