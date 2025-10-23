// Dashboard state
let refreshInterval;

// Format currency
function formatCurrency(value) {
  return '$' + (value || 0).toFixed(4);
}

// Format number
function formatNumber(value) {
  return (value || 0).toLocaleString();
}

// Format date
function formatDate(timestamp) {
  const date = new Date(timestamp);
  return date.toLocaleString();
}

// Format time ago
function timeAgo(timestamp) {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);

  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

// Fetch consumers data
async function fetchConsumers() {
  try {
    const response = await fetch('/api/consumers');
    if (!response.ok) throw new Error('Failed to fetch consumers');
    return await response.json();
  } catch (error) {
    console.error('Error fetching consumers:', error);
    return [];
  }
}

// Fetch requests/audit log
async function fetchRequests(limit = 25) {
  try {
    const response = await fetch(`/api/audit?limit=${limit}`);
    if (!response.ok) throw new Error('Failed to fetch requests');
    return await response.json();
  } catch (error) {
    console.error('Error fetching requests:', error);
    return [];
  }
}

// Fetch AI Proxy status
async function fetchAIProxyStatus() {
  try {
    const response = await fetch('/api/ai-proxy/status');
    if (!response.ok) throw new Error('Failed to fetch AI Proxy status');
    return await response.json();
  } catch (error) {
    console.error('Error fetching AI Proxy status:', error);
    return { configured: false, providers: [] };
  }
}

// Render AI Proxy status
function renderAIProxyStatus(status) {
  const container = document.getElementById('ai-proxy-status');

  if (!status.configured) {
    container.innerHTML = `
      <div class="text-yellow-600 flex items-center gap-2">
        <span class="text-2xl">⚠️</span>
        <span>AI Proxy not configured. Set OPENAI_API_KEY and restart.</span>
      </div>
    `;
    return;
  }

  const providersHTML = status.providers.map(provider => {
    const statusColor = provider.enabled && provider.configured ? 'text-green-600' : 'text-red-600';
    const statusIcon = provider.enabled && provider.configured ? '✅' : '❌';
    const statusText = provider.enabled && provider.configured ? 'Active' : 'Inactive';

    return `
      <div class="flex items-start justify-between p-4 border border-gray-200 rounded-lg">
        <div>
          <div class="font-semibold text-lg text-gray-900">${provider.provider.toUpperCase()}</div>
          <div class="text-sm text-gray-600">Model: ${provider.model}</div>
          <div class="text-sm text-gray-600">Route: ${provider.route_type}</div>
          ${provider.max_tokens ? `<div class="text-sm text-gray-600">Max Tokens: ${provider.max_tokens}</div>` : ''}
          ${provider.temperature ? `<div class="text-sm text-gray-600">Temperature: ${provider.temperature}</div>` : ''}
        </div>
        <div class="${statusColor} font-medium flex items-center gap-2">
          <span>${statusIcon}</span>
          <span>${statusText}</span>
        </div>
      </div>
    `;
  }).join('');

  container.innerHTML = `
    <div class="space-y-3">
      <div class="text-sm text-gray-600 mb-3">
        ${status.count} provider${status.count !== 1 ? 's' : ''} configured
      </div>
      ${providersHTML}
    </div>
  `;
}

// Update statistics
function updateStats(consumers, requests) {
  const totalConsumers = consumers.length;
  const totalRequests = requests.length;
  const totalTokens = requests.reduce((sum, r) => sum + (r.total_tokens || 0), 0);
  const totalCost = requests.reduce((sum, r) => sum + (r.cost || 0), 0);

  document.getElementById('total-consumers').textContent = formatNumber(totalConsumers);
  document.getElementById('total-requests').textContent = formatNumber(totalRequests);
  document.getElementById('total-tokens').textContent = formatNumber(totalTokens);
  document.getElementById('total-cost').textContent = formatCurrency(totalCost);
}

// Render consumers table
function renderConsumersTable(consumers) {
  const tbody = document.querySelector('#consumers-table tbody');

  if (consumers.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" class="px-4 py-8 text-center text-gray-500 italic">No consumers found</td></tr>';
    return;
  }

  tbody.innerHTML = consumers.map(consumer => {
    const remaining = consumer.quota - consumer.used;
    const percentUsed = ((consumer.used / consumer.quota) * 100).toFixed(1);
    let badgeColor = 'bg-green-100 text-green-800';
    if (percentUsed > 80) badgeColor = 'bg-red-100 text-red-800';
    else if (percentUsed > 50) badgeColor = 'bg-yellow-100 text-yellow-800';

    return `
      <tr class="hover:bg-gray-50">
        <td class="px-4 py-3"><strong class="text-gray-900">${consumer.username || 'N/A'}</strong></td>
        <td class="px-4 py-3"><span class="font-mono text-xs text-gray-600">${consumer.id.substring(0, 16)}...</span></td>
        <td class="px-4 py-3 text-gray-700">${formatCurrency(consumer.quota)}</td>
        <td class="px-4 py-3"><span class="inline-block px-2 py-1 rounded text-xs font-medium ${badgeColor}">${formatCurrency(consumer.used)} (${percentUsed}%)</span></td>
        <td class="px-4 py-3 font-medium text-green-600">${formatCurrency(remaining)}</td>
        <td class="px-4 py-3 text-gray-700">${consumer.requests || 0}</td>
        <td class="px-4 py-3">
          <button
            class="delete-consumer-btn px-3 py-1 bg-red-600 text-white text-sm rounded hover:bg-red-700 transition-colors"
            data-consumer-id="${consumer.id}"
            data-consumer-username="${consumer.username || 'N/A'}"
          >
            Delete
          </button>
        </td>
      </tr>
    `;
  }).join('');

  // Attach delete event listeners
  document.querySelectorAll('.delete-consumer-btn').forEach(btn => {
    btn.addEventListener('click', handleDeleteConsumer);
  });
}

// Render requests table
function renderRequestsTable(requests) {
  const tbody = document.querySelector('#requests-table tbody');

  if (requests.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" class="px-4 py-8 text-center text-gray-500 italic">No requests found</td></tr>';
    return;
  }

  tbody.innerHTML = requests.map(request => {
    const statusColor = request.status === 'success' ? 'text-green-600 font-medium' : 'text-red-600 font-medium';
    const consumerId = request.consumer_id ? request.consumer_id.substring(0, 12) + '...' : 'N/A';

    return `
      <tr class="hover:bg-gray-50">
        <td class="px-4 py-3 text-sm text-gray-600" title="${formatDate(request.created_at)}">${timeAgo(request.created_at)}</td>
        <td class="px-4 py-3"><span class="font-mono text-xs text-gray-600">${consumerId}</span></td>
        <td class="px-4 py-3 text-gray-700">${request.provider || 'N/A'}</td>
        <td class="px-4 py-3 text-gray-700">${request.model || 'N/A'}</td>
        <td class="px-4 py-3 text-gray-700">${formatNumber(request.total_tokens)}</td>
        <td class="px-4 py-3 font-medium text-green-600">${formatCurrency(request.cost)}</td>
        <td class="px-4 py-3"><span class="${statusColor}">${request.status || 'unknown'}</span></td>
      </tr>
    `;
  }).join('');
}

// Load and refresh dashboard
async function loadDashboard() {
  const limit = document.getElementById('limit-select').value;

  const [consumers, requests, aiProxyStatus] = await Promise.all([
    fetchConsumers(),
    fetchRequests(limit),
    fetchAIProxyStatus()
  ]);

  updateStats(consumers, requests);
  renderConsumersTable(consumers);
  renderRequestsTable(requests);
  renderAIProxyStatus(aiProxyStatus);
}

// Create consumer
async function createConsumer(username, customId, quota) {
  try {
    const body = { username, quota: parseFloat(quota) };
    if (customId) body.custom_id = customId;

    const response = await fetch('/api/admin/consumers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || 'Failed to create consumer');
    }

    return data;
  } catch (error) {
    throw error;
  }
}

// Delete consumer
async function deleteConsumer(consumerId) {
  try {
    const response = await fetch(`/api/admin/consumers/${consumerId}`, {
      method: 'DELETE'
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || 'Failed to delete consumer');
    }

    return data;
  } catch (error) {
    throw error;
  }
}

// Handle delete consumer button click
async function handleDeleteConsumer(event) {
  const consumerId = event.target.dataset.consumerId;
  const consumerUsername = event.target.dataset.consumerUsername;

  if (!confirm(`Are you sure you want to delete consumer "${consumerUsername}"?\n\nThis will remove the consumer from Kong and delete all associated data.`)) {
    return;
  }

  try {
    event.target.disabled = true;
    event.target.textContent = 'Deleting...';

    await deleteConsumer(consumerId);

    // Refresh dashboard
    await loadDashboard();
  } catch (error) {
    alert(`Failed to delete consumer: ${error.message}`);
    event.target.disabled = false;
    event.target.textContent = 'Delete';
  }
}

// Show/hide create consumer form
function toggleCreateConsumerForm(show) {
  const form = document.getElementById('create-consumer-form');
  const messageDiv = document.getElementById('create-consumer-message');

  if (show) {
    form.classList.remove('hidden');
    // Clear form
    document.getElementById('consumer-username').value = '';
    document.getElementById('consumer-custom-id').value = '';
    document.getElementById('consumer-quota').value = '100';
    messageDiv.classList.add('hidden');
  } else {
    form.classList.add('hidden');
  }
}

// Show message in create consumer form
function showMessage(message, isError = false) {
  const messageDiv = document.getElementById('create-consumer-message');
  messageDiv.innerHTML = ''; // Clear previous content including buttons
  const textNode = document.createTextNode(message);
  messageDiv.appendChild(textNode);
  messageDiv.className = isError
    ? 'mt-3 p-3 rounded-lg bg-red-100 text-red-800 border border-red-300'
    : 'mt-3 p-3 rounded-lg bg-green-100 text-green-800 border border-green-300';
  messageDiv.classList.remove('hidden');
}

// Initialize dashboard
document.addEventListener('DOMContentLoaded', () => {
  // Initial load
  loadDashboard();

  // Auto-refresh every 5 seconds
  refreshInterval = setInterval(loadDashboard, 5000);

  // Manual refresh button
  document.getElementById('refresh-btn').addEventListener('click', () => {
    loadDashboard();
  });

  // Limit select change
  document.getElementById('limit-select').addEventListener('change', () => {
    loadDashboard();
  });

  // Create consumer button
  document.getElementById('create-consumer-btn').addEventListener('click', () => {
    toggleCreateConsumerForm(true);
  });

  // Cancel button
  document.getElementById('cancel-consumer-btn').addEventListener('click', () => {
    toggleCreateConsumerForm(false);
  });

  // Submit consumer button
  document.getElementById('submit-consumer-btn').addEventListener('click', async () => {
    const username = document.getElementById('consumer-username').value.trim();
    const customId = document.getElementById('consumer-custom-id').value.trim();
    const quota = document.getElementById('consumer-quota').value;

    if (!username) {
      showMessage('Username is required', true);
      return;
    }

    if (!quota || quota <= 0) {
      showMessage('Quota must be greater than 0', true);
      return;
    }

    try {
      const submitBtn = document.getElementById('submit-consumer-btn');
      submitBtn.disabled = true;
      submitBtn.textContent = 'Creating...';

      const result = await createConsumer(username, customId, quota);

      showMessage(
        `Consumer created successfully!\n\nAPI Key: ${result.api_key}\n\n⚠️ Save this API key! It won't be shown again.`,
        false
      );

      // Add copy button to message
      const messageDiv = document.getElementById('create-consumer-message');
      const copyBtn = document.createElement('button');
      copyBtn.textContent = '📋 Copy API Key';
      copyBtn.className = 'mt-2 px-3 py-1 bg-white border border-green-600 text-green-700 rounded hover:bg-green-50 transition-colors font-medium';
      copyBtn.onclick = () => {
        navigator.clipboard.writeText(result.api_key);
        copyBtn.textContent = '✅ Copied!';
        setTimeout(() => copyBtn.textContent = '📋 Copy API Key', 2000);
      };
      messageDiv.appendChild(copyBtn);

      // Refresh dashboard (but don't close form)
      loadDashboard();
    } catch (error) {
      showMessage(error.message, true);
    } finally {
      const submitBtn = document.getElementById('submit-consumer-btn');
      submitBtn.disabled = false;
      submitBtn.textContent = 'Create';
    }
  });
});

// LLM Test functionality
async function testLLM(apiKey, prompt) {
  const response = await fetch('http://localhost:8000/llm/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': apiKey
    },
    body: JSON.stringify({
      messages: [
        { role: 'user', content: prompt }
      ]
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`LLM request failed (${response.status}): ${errorText}`);
  }

  return await response.json();
}

// LLM Test button handler
document.addEventListener('DOMContentLoaded', () => {
  const testBtn = document.getElementById('test-llm-btn');
  const apiKeyInput = document.getElementById('test-api-key');
  const promptInput = document.getElementById('test-prompt');
  const responseContainer = document.getElementById('llm-response-container');
  const errorContainer = document.getElementById('llm-error-container');

  testBtn.addEventListener('click', async () => {
    const apiKey = apiKeyInput.value.trim();
    const prompt = promptInput.value.trim();

    // Hide previous results
    responseContainer.classList.add('hidden');
    errorContainer.classList.add('hidden');

    // Validate inputs
    if (!apiKey) {
      errorContainer.classList.remove('hidden');
      document.getElementById('llm-error-text').textContent = 'Please enter an API key';
      return;
    }

    if (!prompt) {
      errorContainer.classList.remove('hidden');
      document.getElementById('llm-error-text').textContent = 'Please enter a prompt';
      return;
    }

    try {
      testBtn.disabled = true;
      testBtn.textContent = 'Sending...';

      const result = await testLLM(apiKey, prompt);

      // Display response
      const message = result.choices[0]?.message?.content || 'No response';
      document.getElementById('llm-response-text').textContent = message;

      // Display token usage
      const usage = result.usage || {};
      document.getElementById('llm-prompt-tokens').textContent = formatNumber(usage.prompt_tokens || 0);
      document.getElementById('llm-completion-tokens').textContent = formatNumber(usage.completion_tokens || 0);

      // Calculate cost (GPT-5 pricing)
      const cost = (usage.prompt_tokens * 0.00000125) + (usage.completion_tokens * 0.00001);
      document.getElementById('llm-cost').textContent = formatCurrency(cost);

      responseContainer.classList.remove('hidden');

      // Refresh dashboard to show updated usage
      setTimeout(() => loadDashboard(), 1000);

    } catch (error) {
      errorContainer.classList.remove('hidden');
      document.getElementById('llm-error-text').textContent = error.message;
    } finally {
      testBtn.disabled = false;
      testBtn.textContent = 'Send Request';
    }
  });
});

// Clean up on page unload
window.addEventListener('beforeunload', () => {
  if (refreshInterval) {
    clearInterval(refreshInterval);
  }
});
