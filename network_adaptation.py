# network_adaptation.py
import logging

log = logging.getLogger("network_adaptation")

def evaluate_network(stats: dict):
    """
    Evaluate network conditions and recommend adaptation mode.
    
    Args:
        stats (dict): Network statistics with keys:
            - rtt: Round-trip time in milliseconds
            - packetLoss: Packet loss ratio (0-1)
            - bandwidth: Available bandwidth in kbps
    
    Returns:
        str: One of "normal", "degrade-video", "audio-only", "captions-only"
    """
    # Extract stats with safe defaults
    rtt = float(stats.get("rtt", 0) or 0)
    loss = float(stats.get("packetLoss", 0) or 0)
    bandwidth = float(stats.get("bandwidth", 1000) or 1000)
    
    # Log the network conditions for debugging
    log.info(f"Network evaluation: RTT={rtt}ms, Loss={loss:.1%}, Bandwidth={bandwidth}kbps")
    
    # Define thresholds for different quality levels
    THRESHOLDS = {
        "critical": {
            "rtt": 500,        # 500ms+ RTT is critical
            "loss": 0.15,      # 15%+ packet loss is critical
            "bandwidth": 100   # <100kbps is critical
        },
        "poor": {
            "rtt": 300,        # 300ms+ RTT is poor
            "loss": 0.08,      # 8%+ packet loss is poor
            "bandwidth": 200   # <200kbps is poor
        },
        "degraded": {
            "rtt": 150,        # 150ms+ RTT causes degradation
            "loss": 0.03,      # 3%+ packet loss causes degradation
            "bandwidth": 500   # <500kbps causes degradation
        }
    }
    
    # Determine adaptation mode based on worst condition
    if (loss >= THRESHOLDS["critical"]["loss"] or 
        rtt >= THRESHOLDS["critical"]["rtt"] or 
        bandwidth < THRESHOLDS["critical"]["bandwidth"]):
        mode = "captions-only"
        
    elif (loss >= THRESHOLDS["poor"]["loss"] or 
          rtt >= THRESHOLDS["poor"]["rtt"] or 
          bandwidth < THRESHOLDS["poor"]["bandwidth"]):
        mode = "audio-only"
        
    elif (loss >= THRESHOLDS["degraded"]["loss"] or 
          rtt >= THRESHOLDS["degraded"]["rtt"] or 
          bandwidth < THRESHOLDS["degraded"]["bandwidth"]):
        mode = "degrade-video"
        
    else:
        mode = "normal"
    
    log.info(f"Network adaptation mode: {mode}")
    return mode

def get_optimization_suggestions(stats: dict):
    """
    Get specific suggestions for improving network conditions.
    
    Args:
        stats (dict): Network statistics
        
    Returns:
        list: List of optimization suggestions
    """
    suggestions = []
    
    rtt = float(stats.get("rtt", 0) or 0)
    loss = float(stats.get("packetLoss", 0) or 0)
    bandwidth = float(stats.get("bandwidth", 1000) or 1000)
    
    if rtt > 200:
        suggestions.append("High latency detected. Consider using a closer server or checking network route.")
    
    if loss > 0.05:
        suggestions.append("Packet loss detected. Check network stability and Wi-Fi signal strength.")
    
    if bandwidth < 500:
        suggestions.append("Low bandwidth detected. Close other applications using internet or upgrade connection.")
    
    if rtt < 50 and loss < 0.01 and bandwidth > 1000:
        suggestions.append("Network conditions are excellent for high-quality video calls.")
    
    return suggestions

def get_quality_metrics(stats: dict):
    """
    Calculate quality score and metrics for network conditions.
    
    Args:
        stats (dict): Network statistics
        
    Returns:
        dict: Quality metrics including overall score
    """
    rtt = float(stats.get("rtt", 0) or 0)
    loss = float(stats.get("packetLoss", 0) or 0)
    bandwidth = float(stats.get("bandwidth", 1000) or 1000)
    
    # Calculate individual scores (0-100)
    rtt_score = max(0, min(100, 100 - (rtt / 5)))  # Perfect at 0ms, 0 at 500ms+
    loss_score = max(0, min(100, 100 - (loss * 500)))  # Perfect at 0%, 0 at 20%+
    bw_score = max(0, min(100, bandwidth / 10))  # Perfect at 1000kbps+
    
    # Overall score (weighted average)
    overall_score = (rtt_score * 0.3 + loss_score * 0.4 + bw_score * 0.3)
    
    return {
        "overall_score": round(overall_score, 1),
        "rtt_score": round(rtt_score, 1),
        "loss_score": round(loss_score, 1),
        "bandwidth_score": round(bw_score, 1),
        "quality_level": get_quality_level(overall_score)
    }

def get_quality_level(score):
    """Convert numeric score to quality level description"""
    if score >= 80:
        return "Excellent"
    elif score >= 60:
        return "Good"
    elif score >= 40:
        return "Fair"
    elif score >= 20:
        return "Poor"
    else:
        return "Critical"

# Test function
if __name__ == "__main__":
    print("Testing Network Adaptation Module")
    print("=" * 40)
    
    test_cases = [
        {"rtt": 50, "packetLoss": 0.01, "bandwidth": 1000},  # Excellent
        {"rtt": 150, "packetLoss": 0.03, "bandwidth": 600},  # Degraded
        {"rtt": 300, "packetLoss": 0.08, "bandwidth": 250},  # Poor
        {"rtt": 500, "packetLoss": 0.15, "bandwidth": 50},   # Critical
    ]
    
    for i, stats in enumerate(test_cases, 1):
        print(f"\nTest Case {i}: {stats}")
        mode = evaluate_network(stats)
        metrics = get_quality_metrics(stats)
        suggestions = get_optimization_suggestions(stats)
        
        print(f"Mode: {mode}")
        print(f"Quality: {metrics['quality_level']} ({metrics['overall_score']}/100)")
        print(f"Suggestions: {len(suggestions)} items")
    
    print("\n" + "=" * 40)
    print("Test completed!")
    