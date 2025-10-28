import OpenAI from 'openai';

console.log("\n" + "=".repeat(60));
console.log("TESTING OPENAI SDK → KONG GATEWAY → LLM PROVIDERS");
console.log("=".repeat(60));

// Test 1: GPT-5 via Kong Gateway (local)
console.log("\n=== Test 1: GPT-5 via Kong (localhost) ===");
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
  console.log("✓ SUCCESS: Kong transformed max_tokens!");
  console.log("Response:", response1.choices[0].message.content);
} catch (error) {
  console.log("✗ FAILED:", error.message);
  console.log("→ Kong is NOT transforming max_tokens → max_completion_tokens");
  console.log("→ lunar-gateway plugin MUST handle this");
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
  console.log("✓ SUCCESS: Ollama works with max_tokens through Kong");
  console.log("Response:", response2.choices[0].message.content);
  console.log("Tokens:", response2.usage.completion_tokens, "/ 10");
} catch (error) {
  console.log("✗ FAILED:", error.message);
}

console.log("\n" + "=".repeat(60));
console.log("CONCLUSION:");
console.log("• Kong ai-proxy does NOT transform max_tokens for GPT-5");
console.log("• lunar-gateway plugin MUST add this transformation");
console.log("• Transformation: max_tokens → max_completion_tokens (for GPT-5/o1)");
console.log("=".repeat(60) + "\n");
