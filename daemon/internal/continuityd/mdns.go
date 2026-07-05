package continuityd

import (
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/grandcat/zeroconf"
)

const (
	defaultMDNSService = "_continuity._tcp"
	defaultMDNSDomain  = "local."
)

var ErrMDNSAdvertiserRunning = errors.New("mDNS advertiser is already running")

type MDNSAdvertiseStartInput struct {
	Name     string   `json:"name"`
	Service  string   `json:"service,omitempty"`
	Domain   string   `json:"domain,omitempty"`
	Port     int      `json:"port"`
	TXT      []string `json:"txt"`
	Endpoint string   `json:"endpoint"`
	NodeID   string   `json:"nodeId"`
	Provider string   `json:"provider,omitempty"`
	Projects []string `json:"projects,omitempty"`
	Now      string   `json:"now,omitempty"`
}

type MDNSAdvertiseState struct {
	Running   bool     `json:"running"`
	Name      string   `json:"name,omitempty"`
	Service   string   `json:"service,omitempty"`
	Domain    string   `json:"domain,omitempty"`
	Port      int      `json:"port,omitempty"`
	Endpoint  string   `json:"endpoint,omitempty"`
	NodeID    string   `json:"nodeId,omitempty"`
	Provider  string   `json:"provider,omitempty"`
	Projects  []string `json:"projects,omitempty"`
	StartedAt string   `json:"startedAt,omitempty"`
}

type MDNSAdvertiseStopResult struct {
	Stopped bool `json:"stopped"`
}

type MDNSAdvertiser struct {
	mu       sync.Mutex
	register mdnsRegisterFunc
	server   mdnsRegistration
	state    MDNSAdvertiseState
}

func NewMDNSAdvertiser() *MDNSAdvertiser {
	return &MDNSAdvertiser{register: registerZeroconf}
}

type mdnsRegistration interface {
	Shutdown()
}

type mdnsRegisterFunc func(name string, service string, domain string, port int, text []string) (mdnsRegistration, error)

func registerZeroconf(name string, service string, domain string, port int, text []string) (mdnsRegistration, error) {
	return zeroconf.Register(name, service, domain, port, text, nil)
}

func (a *MDNSAdvertiser) Start(input MDNSAdvertiseStartInput) (MDNSAdvertiseState, error) {
	a.mu.Lock()
	defer a.mu.Unlock()

	if a.server != nil {
		return MDNSAdvertiseState{}, ErrMDNSAdvertiserRunning
	}
	if input.Name == "" {
		return MDNSAdvertiseState{}, errors.New("name is required")
	}
	if input.Port <= 0 || input.Port > 65535 {
		return MDNSAdvertiseState{}, fmt.Errorf("invalid port %d", input.Port)
	}
	service := input.Service
	if service == "" {
		service = defaultMDNSService
	}
	domain := input.Domain
	if domain == "" {
		domain = defaultMDNSDomain
	}
	startedAt := input.Now
	if startedAt == "" {
		startedAt = time.Now().UTC().Format(time.RFC3339Nano)
	}

	server, err := a.register(input.Name, service, domain, input.Port, input.TXT)
	if err != nil {
		return MDNSAdvertiseState{}, fmt.Errorf("start mDNS advertiser: %w", err)
	}
	a.server = server
	a.state = MDNSAdvertiseState{
		Running:   true,
		Name:      input.Name,
		Service:   service,
		Domain:    domain,
		Port:      input.Port,
		Endpoint:  input.Endpoint,
		NodeID:    input.NodeID,
		Provider:  input.Provider,
		Projects:  input.Projects,
		StartedAt: startedAt,
	}
	return a.state, nil
}

func (a *MDNSAdvertiser) Status() MDNSAdvertiseState {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.server == nil {
		return MDNSAdvertiseState{Running: false}
	}
	state := a.state
	state.Running = true
	return state
}

func (a *MDNSAdvertiser) Stop() MDNSAdvertiseStopResult {
	a.mu.Lock()
	if a.server == nil {
		a.mu.Unlock()
		return MDNSAdvertiseStopResult{Stopped: false}
	}
	server := a.server
	a.server = nil
	a.state = MDNSAdvertiseState{}
	a.mu.Unlock()

	go server.Shutdown()
	return MDNSAdvertiseStopResult{Stopped: true}
}
