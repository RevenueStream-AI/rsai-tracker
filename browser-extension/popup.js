document.addEventListener('DOMContentLoaded', async function () {
    var stored = await chrome.storage.local.get('amcEmail');
    var input = document.getElementById('emailInput');
    var status = document.getElementById('status');
    if (stored.amcEmail) {
          input.value = stored.amcEmail;
          status.textContent = 'Tracking activity for ' + stored.amcEmail;
    }
    document.getElementById('saveBtn').addEventListener('click', async function () {
          var email = input.value.trim().toLowerCase();
          if (!email || email.indexOf('@') === -1) {
                  status.textContent = 'Please enter a valid email.';
                  return;
          }
          await chrome.storage.local.set({ amcEmail: email });
          status.textContent = 'Saved! Tracking activity for ' + email;
    });
});
