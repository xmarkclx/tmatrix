package backend

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"runtime"
	"strings"
	"time"

	"tmatrix/internal/config"
)

var errActionNotFound = errors.New("worker or engine action is no longer available")
var errActionConflict = errors.New("worker cannot accept this action in its current state")
var errActionValues = errors.New("engine rejected the requested values")

var ErrUpgradeBusy = errors.New("upgrade deferred while workers are active; retry after they finish")

type discovery struct {
	Version int    `json:"version"`
	URL     string `json:"url"`
	Token   string `json:"token"`
	PID     int    `json:"pid"`
}

// HTTP accesses only the authenticated loopback bridge discovered in TMatrix's
// own private state directory. It never sends bridge credentials to Tzu Do.
type HTTP struct {
	baseURL string
	token   string
	client  *http.Client
}

func NewHTTP(discoveryPath string) (*HTTP, error) {
	info, err := os.Lstat(discoveryPath)
	if errors.Is(err, os.ErrNotExist) {
		return nil, errors.New("TMatrix engine is not running; connect the Tzu Do poller first")
	}
	if err != nil || !info.Mode().IsRegular() || info.Size() > 16384 || (runtime.GOOS != "windows" && info.Mode().Perm()&0077 != 0) {
		return nil, errors.New("engine discovery must be a private regular file")
	}
	data, err := os.ReadFile(discoveryPath)
	if err != nil {
		return nil, errors.New("cannot read engine discovery")
	}
	var d discovery
	if json.Unmarshal(data, &d) != nil || d.Version != 1 || d.PID <= 0 || len(d.Token) < 16 || strings.ContainsAny(d.Token, "\r\n\x00 ") {
		return nil, errors.New("invalid engine discovery; restart the TMatrix engine")
	}
	u, err := url.Parse(d.URL)
	if err != nil {
		return nil, errors.New("invalid engine bridge address")
	}
	ip := net.ParseIP(u.Hostname())
	if u.Scheme != "http" || ip == nil || !ip.IsLoopback() || u.Port() == "" || u.User != nil || (u.Path != "" && u.Path != "/") || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" || u.Opaque != "" {
		return nil, errors.New("engine bridge must use a loopback IP and explicit port")
	}
	return &HTTP{baseURL: strings.TrimSuffix(d.URL, "/"), token: d.Token, client: &http.Client{
		Timeout: 5 * time.Second,
		// Disable proxies and redirects so credentials cannot escape loopback.
		Transport:     &http.Transport{Proxy: nil, DisableKeepAlives: true},
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}}, nil
}

func (h *HTTP) Snapshot(ctx context.Context) (Snapshot, error) {
	var result Snapshot
	err := h.request(ctx, http.MethodGet, "/v1/snapshot", nil, &result)
	if err == nil && (result.Version != 1 || result.MaxWorkers < 1 || result.MaxWorkers > 100 || result.RunningWorkers < 0) {
		return Snapshot{}, errors.New("engine returned an unsupported snapshot")
	}
	return result, err
}

func (h *HTTP) Steer(ctx context.Context, id, message string) (Steering, error) {
	if err := validateMessage(message); err != nil {
		return Steering{}, err
	}
	if err := validateID(id); err != nil {
		return Steering{}, err
	}
	var result Steering
	err := h.request(ctx, http.MethodPost, "/v1/workers/"+url.PathEscape(id)+"/steer", map[string]string{"message": message, "request_id": config.NewID()}, &result)
	if err == nil && (result.ID == "" || result.Status != "queued") {
		return Steering{}, errors.New("engine returned an invalid steering acknowledgement")
	}
	return result, err
}

func (h *HTTP) Stop(ctx context.Context, id string) error {
	if err := validateID(id); err != nil {
		return err
	}
	return h.request(ctx, http.MethodPost, "/v1/workers/"+url.PathEscape(id)+"/stop", struct{}{}, nil)
}

func (h *HTTP) Pin(ctx context.Context, id string, pinned bool) error {
	if err := validateID(id); err != nil {
		return err
	}
	err := h.request(ctx, http.MethodPost, "/v1/workers/"+url.PathEscape(id)+"/pin", map[string]bool{"pinned": pinned}, nil)
	if !errors.Is(err, errActionNotFound) {
		return err
	}
	// Older engines use the same 404 for an unknown endpoint and a missing
	// worker. Check fresh state without inspecting potentially private bodies.
	snapshot, snapshotErr := h.Snapshot(ctx)
	if snapshotErr != nil {
		return errors.New("pin unavailable; reconnect to the engine and retry")
	}
	for _, worker := range snapshot.Workers {
		if worker.ID == id {
			return errors.New("engine update needed for pinning; Settings → Restart engine")
		}
	}
	return errors.New("worker finished or was removed before it could be pinned")
}

func (h *HTTP) Configure(ctx context.Context, settings Settings) error {
	if err := ValidateSettings(settings); err != nil {
		return err
	}
	return h.request(ctx, http.MethodPost, "/v1/settings", settings, nil)
}

func (h *HTTP) Connect(context.Context, Connection) error {
	return errors.New("poller connection must be configured by the TMatrix application")
}

func (h *HTTP) Shutdown(ctx context.Context) error {
	return h.request(ctx, http.MethodPost, "/v1/shutdown", struct{}{}, nil)
}

// ShutdownIfIdle atomically refuses to stop intake when a worker is active.
// Older engines must be stopped explicitly while idle before upgrading.
func (h *HTTP) ShutdownIfIdle(ctx context.Context) error {
	var result struct {
		Status string `json:"status"`
	}
	err := h.request(ctx, http.MethodPost, "/v1/shutdown", map[string]bool{"only_if_idle": true}, &result)
	if errors.Is(err, errActionConflict) {
		return ErrUpgradeBusy
	}
	if errors.Is(err, errActionValues) || errors.Is(err, errActionNotFound) {
		return errors.New("engine does not support idle-only upgrades; when workers finish, run tmatrix engine stop, wait for it to exit, then retry")
	}
	if err == nil && result.Status != "shutting_down" {
		return errors.New("engine did not acknowledge idle shutdown")
	}
	return err
}

func (h *HTTP) CheckAdapterUpdate(ctx context.Context) error {
	return h.adapterUpdateAction(ctx, "/v1/adapter/check-now")
}

func (h *HTTP) RollbackAdapterUpdate(ctx context.Context) error {
	return h.adapterUpdateAction(ctx, "/v1/adapter/rollback")
}

func (h *HTTP) adapterUpdateAction(ctx context.Context, path string) error {
	var result struct {
		OK bool `json:"ok"`
	}
	err := h.request(ctx, http.MethodPost, path, struct{}{}, &result)
	if errors.Is(err, errActionNotFound) {
		return errors.New("runtime updates are unavailable in this engine")
	}
	if errors.Is(err, errActionConflict) {
		return errors.New("runtime update action is unavailable in the current state; refresh and retry")
	}
	if err == nil && !result.OK {
		return errors.New("engine did not acknowledge the runtime update request")
	}
	return err
}

func validateID(id string) error {
	if id == "" || len(id) > 200 || strings.ContainsAny(id, "/\\?#\r\n\x00") || id == "." || id == ".." {
		return errors.New("invalid worker ID")
	}
	return nil
}

func (h *HTTP) request(ctx context.Context, method, path string, body, output any) error {
	var data []byte
	if body != nil {
		var err error
		data, err = json.Marshal(body)
		if err != nil {
			return errors.New("cannot encode engine request")
		}
		if len(data) > 16384 {
			return errors.New("engine request exceeds 16 KiB; shorten the message")
		}
	}
	request, err := http.NewRequestWithContext(ctx, method, h.baseURL+path, bytes.NewReader(data))
	if err != nil {
		return errors.New("cannot prepare engine request")
	}
	request.Header.Set("Authorization", "Bearer "+h.token)
	request.Header.Set("Content-Type", "application/json")
	response, err := h.client.Do(request)
	if err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return errors.New("cannot reach the local TMatrix engine")
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		// Runtime bodies can contain task text and credentials in provider errors.
		// Surface only status classes; raw local logs stay outside the UI.
		switch response.StatusCode {
		case 401, 403:
			return errors.New("local engine authorization failed; restart or reconnect TMatrix")
		case 404:
			return errActionNotFound
		case 409:
			return errActionConflict
		case 400, 422:
			return errActionValues
		default:
			return fmt.Errorf("local engine request failed (HTTP %d)", response.StatusCode)
		}
	}
	if output == nil {
		return nil
	}
	data, err = io.ReadAll(io.LimitReader(response.Body, 16*1024*1024+1))
	if err != nil || len(data) > 16*1024*1024 {
		return errors.New("engine response is unreadable or too large")
	}
	if err := json.Unmarshal(data, output); err != nil {
		return errors.New("engine returned an invalid response")
	}
	return nil
}
