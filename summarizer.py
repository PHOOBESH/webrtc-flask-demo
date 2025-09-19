import google.generativeai as genai

# ⚠️ Hardcoded API key (demo only)
API_KEY = "AIzaSyDD3-4VGqZbncObJ7_VFA2UeovjrEO6ag0"
genai.configure(api_key=API_KEY)

# Load Gemini model
model = genai.GenerativeModel("gemini-1.5-flash")

def summarize_and_extract(transcript):
    prompt = f"""
    You are an AI meeting assistant. Analyze the following transcript and produce:
    1. A concise meeting summary (3-5 sentences).
    2. Clear meeting minutes (MOM).
    3. Action items with assignees if mentioned.

    Transcript:
    {transcript}

    Format the response as:
    📋 Summary:
    ...
    
    📝 Meeting Minutes:
    - Point 1
    - Point 2
    
    ✅ Action Items:
    - Task 1
    - Task 2
    """
    
    response = model.generate_content(prompt)
    return response.text

if __name__ == "__main__":
    print("👉 Paste your meeting transcript below (press Enter to submit):\n")
    transcript = input("Transcript: ")
    result = summarize_and_extract(transcript)
    print("\n===== AI Generated Meeting Summary =====\n")
    print(result)
