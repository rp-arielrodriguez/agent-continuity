package continuityd

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"os/exec"
	"strconv"
	"strings"
)

type PeerDiscoverInput struct {
	Providers      []string `json:"providers"`
	Port           int      `json:"port"`
	TrustedNames   []string `json:"trustedNames,omitempty"`
	TrustedNodeIDs []string `json:"trustedNodeIds,omitempty"`
}

type PeerDiscoverResult struct {
	Peers    []DiscoveredPeer `json:"peers"`
	Warnings []string         `json:"warnings,omitempty"`
}

type DiscoveredPeer struct {
	Provider string `json:"provider"`
	NodeID   string `json:"nodeId,omitempty"`
	Name     string `json:"name,omitempty"`
	Endpoint string `json:"endpoint"`
	Online   bool   `json:"online"`
}

func DiscoverPeers(ctx context.Context, input PeerDiscoverInput) (PeerDiscoverResult, error) {
	if input.Port <= 0 || input.Port > 65535 {
		return PeerDiscoverResult{}, rpcInvalidParams(errors.New("port must be between 1 and 65535"))
	}
	if len(input.TrustedNames) == 0 && len(input.TrustedNodeIDs) == 0 {
		return PeerDiscoverResult{}, rpcInvalidParams(errors.New("trustedNames or trustedNodeIds is required"))
	}
	providers := input.Providers
	if len(providers) == 0 {
		providers = []string{"tailscale", "zerotier"}
	}

	result := PeerDiscoverResult{Peers: []DiscoveredPeer{}, Warnings: []string{}}
	for _, provider := range providers {
		switch strings.ToLower(strings.TrimSpace(provider)) {
		case "tailscale":
			output, err := exec.CommandContext(ctx, "tailscale", "status", "--json").Output()
			if err != nil {
				result.Warnings = append(result.Warnings, "tailscale discovery failed: "+err.Error())
				continue
			}
			peers, warnings, err := DiscoverTailscalePeers(output, input)
			if err != nil {
				result.Warnings = append(result.Warnings, "tailscale discovery parse failed: "+err.Error())
				continue
			}
			result.Peers = append(result.Peers, peers...)
			result.Warnings = append(result.Warnings, warnings...)
		case "zerotier":
			output, err := exec.CommandContext(ctx, "zerotier-cli", "-j", "listpeers").Output()
			if err != nil {
				result.Warnings = append(result.Warnings, "zerotier discovery failed: "+err.Error())
				continue
			}
			peers, warnings, err := DiscoverZeroTierPeers(output, input)
			if err != nil {
				result.Warnings = append(result.Warnings, "zerotier discovery parse failed: "+err.Error())
				continue
			}
			result.Peers = append(result.Peers, peers...)
			result.Warnings = append(result.Warnings, warnings...)
		default:
			result.Warnings = append(result.Warnings, "unsupported discovery provider: "+provider)
		}
	}
	return result, nil
}

func DiscoverTailscalePeers(data []byte, input PeerDiscoverInput) ([]DiscoveredPeer, []string, error) {
	var status tailscaleStatus
	if err := json.Unmarshal(data, &status); err != nil {
		return nil, nil, err
	}
	var peers []DiscoveredPeer
	var warnings []string
	for mapNodeID, peer := range status.Peer {
		nodeID := firstNonEmpty(peer.ID, mapNodeID)
		names := tailscaleNameVariants(peer)
		if !trustedName(names, input.TrustedNames) && !trustedID(nodeID, input.TrustedNodeIDs) {
			continue
		}
		if !peer.Online {
			warnings = append(warnings, "trusted tailscale peer offline: "+firstNonEmpty(peer.HostName, peer.DNSName, nodeID))
			continue
		}
		if len(peer.TailscaleIPs) == 0 {
			warnings = append(warnings, "trusted tailscale peer has no tailscale IP: "+firstNonEmpty(peer.HostName, peer.DNSName, nodeID))
			continue
		}
		peers = append(peers, DiscoveredPeer{
			Provider: "tailscale",
			NodeID:   nodeID,
			Name:     firstNonEmpty(peer.HostName, strings.TrimSuffix(peer.DNSName, "."), nodeID),
			Endpoint: tcpEndpoint(peer.TailscaleIPs[0], input.Port),
			Online:   true,
		})
	}
	return peers, warnings, nil
}

func DiscoverZeroTierPeers(data []byte, input PeerDiscoverInput) ([]DiscoveredPeer, []string, error) {
	var raw []zerotierPeer
	if err := json.Unmarshal(data, &raw); err != nil {
		return nil, nil, err
	}
	var peers []DiscoveredPeer
	var warnings []string
	for _, peer := range raw {
		if !trustedID(peer.Address, input.TrustedNodeIDs) && !trustedName([]string{peer.Address}, input.TrustedNames) {
			continue
		}
		host := firstZeroTierHost(peer)
		if host == "" {
			warnings = append(warnings, "trusted zerotier peer has no reachable address: "+peer.Address)
			continue
		}
		peers = append(peers, DiscoveredPeer{
			Provider: "zerotier",
			NodeID:   peer.Address,
			Name:     peer.Address,
			Endpoint: tcpEndpoint(host, input.Port),
			Online:   true,
		})
	}
	return peers, warnings, nil
}

type tailscaleStatus struct {
	Peer map[string]tailscalePeer `json:"Peer"`
}

type tailscalePeer struct {
	ID           string   `json:"ID"`
	HostName     string   `json:"HostName"`
	DNSName      string   `json:"DNSName"`
	TailscaleIPs []string `json:"TailscaleIPs"`
	Online       bool     `json:"Online"`
}

type zerotierPeer struct {
	Address string         `json:"address"`
	Paths   []zerotierPath `json:"paths"`
}

type zerotierPath struct {
	Address string `json:"address"`
}

func trustedName(names []string, trusted []string) bool {
	for _, name := range names {
		normalized := normalizeTrustName(name)
		if normalized == "" {
			continue
		}
		for _, trustedName := range trusted {
			if normalized == normalizeTrustName(trustedName) {
				return true
			}
		}
	}
	return false
}

func trustedID(id string, trusted []string) bool {
	normalized := normalizeTrustID(id)
	if normalized == "" {
		return false
	}
	for _, trustedID := range trusted {
		if normalized == normalizeTrustID(trustedID) {
			return true
		}
	}
	return false
}

func normalizeTrustName(value string) string {
	return strings.ToLower(strings.TrimSuffix(strings.TrimSpace(value), "."))
}

func normalizeTrustID(value string) string {
	return strings.ToLower(strings.TrimSpace(value))
}

func tailscaleNameVariants(peer tailscalePeer) []string {
	dnsName := strings.TrimSuffix(peer.DNSName, ".")
	shortDNSName := dnsName
	if index := strings.Index(shortDNSName, "."); index >= 0 {
		shortDNSName = shortDNSName[:index]
	}
	return []string{peer.HostName, dnsName, shortDNSName}
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}

func tcpEndpoint(host string, port int) string {
	return "tcp://" + net.JoinHostPort(strings.Trim(host, "[]"), strconv.Itoa(port))
}

func firstZeroTierHost(peer zerotierPeer) string {
	for _, path := range peer.Paths {
		host := hostFromZeroTierAddress(path.Address)
		if host != "" {
			return host
		}
	}
	return ""
}

func hostFromZeroTierAddress(value string) string {
	if value == "" {
		return ""
	}
	if strings.Contains(value, "/") {
		return strings.SplitN(value, "/", 2)[0]
	}
	if host, _, err := net.SplitHostPort(value); err == nil {
		return host
	}
	if strings.Count(value, ":") > 1 {
		return strings.Trim(value, "[]")
	}
	if strings.Contains(value, ":") {
		return strings.SplitN(value, ":", 2)[0]
	}
	return value
}

func (r PeerDiscoverResult) Endpoints() []string {
	endpoints := make([]string, 0, len(r.Peers))
	for _, peer := range r.Peers {
		endpoints = append(endpoints, peer.Endpoint)
	}
	return endpoints
}
