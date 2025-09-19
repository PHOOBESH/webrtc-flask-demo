# summarizer.py
import os
import logging

log = logging.getLogger("summarizer")

# Try to import Google Generative AI
try:
    import google.generativeai as genai
    GEMINI_AVAILABLE = True
except ImportError:
    log.warning("Google Generative AI not available. Install with: pip install google-generativeai")
    GEMINI_AVAILABLE = False

# Get API key from environment variable for security
API_KEY = os.environ.get("GOOGLE_API_KEY") or os.environ.get("GEMINI_API_KEY")

if GEMINI_AVAILABLE and API_KEY:
    genai.configure(api_key=API_KEY)
    try:
        model = genai.GenerativeModel("gemini-1.5-flash")
        log.info("Gemini model initialized successfully")
    except Exception as e:
        log.error(f"Failed to initialize Gemini model: {e}")
        model = None
else:
    model = None
    if not API_KEY:
        log.warning("No Google API key found. Set GOOGLE_API_KEY or GEMINI_API_KEY environment variable.")

def summarize_and_extract(transcript):
    """
    Analyze meeting transcript and produce summary, minutes, and action items
    
    Args:
        transcript (str): The meeting transcript text
        
    Returns:
        str: Formatted summary with meeting minutes and action items
    """
    if not transcript or not transcript.strip():
        return "📋 Summary:\nNo transcript available yet. Please start the meeting and speak for a few minutes before generating a summary.\n\n📝 Meeting Minutes:\n- No content to summarize\n\n✅ Action Items:\n- No action items identified"
    
    if model is None:
        return generate_mock_summary(transcript)
    
    try:
        prompt = f"""
You are an AI meeting assistant. Analyze the following meeting transcript and produce a comprehensive analysis:

1. A concise meeting summary (2-4 sentences highlighting key topics and outcomes)
2. Detailed meeting minutes with main discussion points
3. Action items with assignees if mentioned, or general action items if no specific assignees

Please format the response exactly as shown below:

📋 Summary:
[Your concise summary here]

📝 Meeting Minutes:
- [Main point 1]
- [Main point 2]
- [Main point 3]
[Add more points as needed]

✅ Action Items:
- [Action item 1]
- [Action item 2]
[Add more items as needed]

If the transcript is very short or unclear, acknowledge this and provide what analysis you can.

Transcript:
{transcript}
"""
        
        response = model.generate_content(prompt)
        
        if response and response.text:
            return response.text.strip()
        else:
            log.warning("Empty response from Gemini model")
            return generate_mock_summary(transcript)
            
    except Exception as e:
        log.error(f"Gemini API call failed: {e}")
        return generate_mock_summary(transcript)

def generate_mock_summary(transcript):
    """
    Generate a mock summary when AI service is not available
    """
    word_count = len(transcript.split()) if transcript else 0
    
    return f"""📋 Summary:
Meeting transcript analyzed ({word_count} words). This is a demo summary generated locally. Key discussion points were covered and participants were engaged in productive conversation.

📝 Meeting Minutes:
- Meeting commenced with introductions and agenda overview
- Participants discussed main topics and shared insights
- Various viewpoints were presented and considered
- Technical aspects and implementation details were reviewed
- Next steps and follow-up actions were identified

✅ Action Items:
- Review meeting transcript and key decisions made
- Follow up on discussed topics in next meeting
- Share relevant documents and resources with team
- Schedule follow-up sessions as needed
- Continue collaboration on identified projects

Note: This is a demo summary. For accurate AI-powered summaries, please configure the Google Gemini API key in your environment variables."""

def extract_action_items(transcript):
    """
    Extract just the action items from a transcript
    """
    if not transcript or not transcript.strip():
        return []
    
    if model is None:
        return [
            "Review meeting transcript",
            "Follow up on key discussion points",
            "Prepare for next meeting"
        ]
    
    try:
        prompt = f"""
Extract specific action items from this meeting transcript. Return only actionable tasks that were mentioned or implied, one per line. If no clear action items exist, return "No specific action items identified."

Transcript:
{transcript}
"""
        
        response = model.generate_content(prompt)
        
        if response and response.text:
            # Parse response into list
            items = [item.strip('- ').strip() for item in response.text.split('\n') if item.strip()]
            return items
        else:
            return ["No specific action items identified"]
            
    except Exception as e:
        log.error(f"Action item extraction failed: {e}")
        return ["Error extracting action items"]

def get_meeting_insights(transcript):
    """
    Get additional insights about the meeting
    """
    if not transcript or not transcript.strip():
        return {
            "duration_estimate": "N/A",
            "participant_count": "N/A", 
            "engagement_level": "N/A",
            "key_topics": []
        }
    
    word_count = len(transcript.split())
    estimated_duration = max(1, word_count // 150)  # Rough estimate: 150 words per minute
    
    return {
        "duration_estimate": f"~{estimated_duration} minutes",
        "word_count": word_count,
        "engagement_level": "High" if word_count > 500 else "Medium" if word_count > 200 else "Low",
        "key_topics": extract_key_topics(transcript)
    }

def extract_key_topics(transcript, max_topics=5):
    """
    Extract key topics from transcript (simple keyword-based approach)
    """
    if not transcript:
        return []
    
    # Simple keyword extraction - in production, use NLP libraries
    common_words = {'the', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by', 'is', 'are', 'was', 'were', 'be', 'been', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should', 'may', 'might', 'can', 'this', 'that', 'these', 'those', 'i', 'you', 'he', 'she', 'it', 'we', 'they', 'me', 'him', 'her', 'us', 'them', 'my', 'your', 'his', 'her', 'its', 'our', 'their'}
    
    words = transcript.lower().split()
    word_freq = {}
    
    for word in words:
        word = word.strip('.,!?";:()[]{}')
        if len(word) > 3 and word not in common_words:
            word_freq[word] = word_freq.get(word, 0) + 1
    
    # Get top topics
    sorted_topics = sorted(word_freq.items(), key=lambda x: x[1], reverse=True)
    return [topic[0] for topic in sorted_topics[:max_topics]]

if __name__ == "__main__":
    # Test the summarizer
    print("🧪 Testing Meeting Summarizer")
    print("=" * 40)
    
    test_transcript = """
    Hello everyone, welcome to today's project meeting. Let's start by reviewing our progress on the new feature development. 
    John mentioned that the backend API is almost complete. Sarah reported that the frontend components are ready for testing.
    We discussed the upcoming deadline and agreed to extend it by one week to ensure quality.
    Action items: John will deploy the API to staging, Sarah will conduct user testing, and Mike will prepare the documentation.
    Next meeting is scheduled for Friday at 2 PM.
    """
    
    result = summarize_and_extract(test_transcript)
    print(result)
    print("\n" + "=" * 40)
    print("Test completed!")