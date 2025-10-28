import OpenAI from 'openai';

// Test 1: GPT-5 via Kong Gateway (local)
console.log("\n=== Test 1: GPT-5 via Kong (curl shows it reaches OpenAI but gets rejected) ===");
const kongOpenAI = new OpenAI({
  apiKey: 'pqII0ivF4USIegTv5NbGxfaQD5lbU7BN',
  baseURL: 'http://localhost:8000/llm',
  defaultHeaders: {
    'apikey': 'pqII0ivF4USIegTv5NbGxfaQD5lbU7BN'
  }
});

try {
  const response1 = await kongOpenAI.chat.completions.create({
    model: 'gpt-5',
    messages: [{ role: 'user', content: 'Say hello' }],
    max_tokens: 10
  });
  console.log("✓ Success with max_tokens:", response1.choices[0].message.content);
  console.log("Usage:", response1.usage);
} catch (error) {
  console.log("✗ Error:", error.message);
  console.log("This confirms Kong does NOT transform max_tokens → max_completion_tokens");
}

// Test 2: Ollama via Kong Gateway (macserver)
console.log("\n=== Test 2: Ollama via Kong (macserver) ===");
const kongOllama = new OpenAI({
  apiKey: 'Ogj0IwIMpigVk6XbF0EHERlJ6OwIqm0J',
  baseURL: 'http://macserver.tailcdff5e.ts.net:8000/local-llm',
  defaultHeaders: {
    'apikey': 'Ogj0IwIMpigVk6XbF0EHERlJ6OwIqm0J'
  }
});

try {
  const response2 = await kongOllama.chat.completions.create({
    model: 'gpt-oss:120b',
    messages: [{ role: 'user', content: 'Say hello' }],
    max_tokens: 10
  });
  console.log("✓ Success with max_tokens:", response2.choices[0].message.content);
  console.log("Usage:", response2.usage);
  console.log("Ollama works with max_tokens through Kong ✓");
} catch (error) {
  console.log("✗ Error:", error.message);
}
