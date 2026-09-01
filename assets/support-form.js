/* ==================================================================== *
   Support form.
   Shared by the section on the home page and the standalone /support/
   page, so the two can never drift into disagreeing about what they
   accept. Posts to the same endpoint the Chrome extension's Get help
   form uses, with the same field names and the same limits.
 * ==================================================================== */

(function () {
    'use strict';

    var ENDPOINT = 'https://b24.palworks.ai/support';
    var MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
    var MAX_MESSAGE_LENGTH = 5000;

    var ALLOWED_TYPES = [
        'image/png',
        'image/jpeg',
        'image/gif',
        'image/webp',
        'application/pdf',
        'text/plain',
        'application/json',
        'application/zip'
    ];

    /* --------------------------------------------------------------- *
       Hosting waitlist.

       Posts to the same endpoint as the support form, tagged so the two
       arrive in the inbox distinguishable from each other. It is the only
       measure of demand for hosted backends, so it has to actually work
       rather than collect addresses into a form that goes nowhere.
     * --------------------------------------------------------------- */
    function setUpWaitlist() {
        var wlForm = document.getElementById('waitlist-form');
        if (!wlForm) {
            return;
        }

        var email = document.getElementById('wl-email');
        var submit = document.getElementById('wl-submit');
        var status = document.getElementById('wl-status');

        function say(text, kind) {
            status.textContent = text;
            status.className = 'form-status is-' + kind;
            status.hidden = false;
        }

        wlForm.addEventListener('submit', function (event) {
            event.preventDefault();

            var value = email.value.trim();
            if (!value || !email.checkValidity()) {
                say('Enter an email address we can reach you at.', 'error');
                email.focus();
                return;
            }

            submit.disabled = true;
            say('Sending...', 'busy');

            fetch(ENDPOINT, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: 'Hosting waitlist',
                    email: value,
                    phone: '',
                    category: 'hosting-waitlist',
                    message: 'Requested notification when hosted backends open.',
                    company: '',
                    context: { source: 'website', page: location.pathname }
                })
            })
                .then(function (response) {
                    if (response.ok) {
                        wlForm.reset();
                        say('Thanks. We will be in touch when it opens.', 'ok');
                        return;
                    }
                    return response
                        .json()
                        .catch(function () {
                            return null;
                        })
                        .then(function (body) {
                            say(
                                body && body.error && body.error.message
                                    ? body.error.message
                                    : 'Could not sign you up. Please try again shortly.',
                                'error'
                            );
                        });
                })
                .catch(function () {
                    say('Could not reach the service. Check your connection and try again.', 'error');
                })
                .then(function () {
                    submit.disabled = false;
                });
        });
    }

    var form = document.getElementById('support-form');

    setUpWaitlist();

    if (!form) {
        return;
    }

    var els = {
        name: document.getElementById('sf-name'),
        email: document.getElementById('sf-email'),
        phone: document.getElementById('sf-phone'),
        category: document.getElementById('sf-category'),
        message: document.getElementById('sf-message'),
        file: document.getElementById('sf-file'),
        company: document.getElementById('sf-company'),
        counter: document.getElementById('sf-counter'),
        status: document.getElementById('sf-status'),
        submit: document.getElementById('sf-submit')
    };

    function setStatus(text, kind) {
        els.status.textContent = text;
        els.status.className = 'form-status is-' + kind;
        els.status.hidden = false;
    }

    function clearStatus() {
        els.status.hidden = true;
    }

    function updateCounter() {
        els.counter.textContent = els.message.value.length + ' / ' + MAX_MESSAGE_LENGTH;
    }

    /* Chunked because building the binary string one character at a time is
       unusably slow at a few megabytes, and String.fromCharCode has an
       argument count limit, so neither extreme works alone. */
    function toBase64(buffer) {
        var bytes = new Uint8Array(buffer);
        var parts = [];
        var chunk = 8192;
        for (var i = 0; i < bytes.length; i += chunk) {
            parts.push(String.fromCharCode.apply(null, bytes.subarray(i, i + chunk)));
        }
        return btoa(parts.join(''));
    }

    /* Browsers report an empty type for extensions they do not recognise, and
       a log file is the single most useful thing to attach to a bug report,
       so text files are recovered from the name. */
    function resolveType(file) {
        if (ALLOWED_TYPES.indexOf(file.type) !== -1) {
            return file.type;
        }
        if (!file.type && /\.(txt|log)$/i.test(file.name)) {
            return 'text/plain';
        }
        return null;
    }

    function readAttachment() {
        var file = els.file && els.file.files && els.file.files[0];
        if (!file) {
            return Promise.resolve(null);
        }
        if (file.size === 0) {
            return Promise.reject(new Error('That file is empty.'));
        }
        if (file.size > MAX_ATTACHMENT_BYTES) {
            return Promise.reject(new Error('That file is larger than 5 MB. Attach a smaller one.'));
        }
        var contentType = resolveType(file);
        if (!contentType) {
            return Promise.reject(
                new Error('That file type is not accepted. Try a PNG, PDF, text or zip file.')
            );
        }
        return file.arrayBuffer().then(function (buffer) {
            return {
                filename: file.name,
                contentType: contentType,
                content: toBase64(buffer)
            };
        });
    }

    els.message.addEventListener('input', updateCounter);
    updateCounter();

    form.addEventListener('submit', function (event) {
        event.preventDefault();
        clearStatus();

        var name = els.name.value.trim();
        var email = els.email.value.trim();
        var phone = els.phone.value.trim();
        var message = els.message.value.trim();

        if (name.length < 2) {
            setStatus('Tell us your name so we know who we are replying to.', 'error');
            els.name.focus();
            return;
        }
        if (!email || !els.email.checkValidity()) {
            setStatus('Enter an email address we can reply to.', 'error');
            els.email.focus();
            return;
        }
        /* Checked here as well as on the server so the correction happens
           while the field is still in front of the person. */
        if (phone && !/^\+[1-9][\d\s\-().]{6,20}$/.test(phone)) {
            setStatus(
                'Include the country code on the phone number, for example +971 50 123 4567.',
                'error'
            );
            els.phone.focus();
            return;
        }
        if (message.length < 10) {
            setStatus('Tell us a little more, at least 10 characters.', 'error');
            els.message.focus();
            return;
        }

        els.submit.disabled = true;
        setStatus('Sending...', 'busy');

        readAttachment()
            .then(function (attachment) {
                var payload = {
                    name: name,
                    email: email,
                    phone: phone,
                    category: els.category.value,
                    message: message,
                    company: els.company.value,
                    context: {
                        source: 'website',
                        page: location.pathname,
                        userAgent: navigator.userAgent
                    }
                };
                if (attachment) {
                    payload.attachment = attachment;
                }
                return fetch(ENDPOINT, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
            })
            .then(function (response) {
                if (response.ok) {
                    form.reset();
                    updateCounter();
                    setStatus('Sent. We will reply to that address.', 'ok');
                    return;
                }
                return response
                    .json()
                    .catch(function () {
                        return null;
                    })
                    .then(function (body) {
                        var reason =
                            body && body.error && body.error.message
                                ? body.error.message
                                : 'Could not send the message. Please try again shortly.';
                        setStatus(reason, 'error');
                    });
            })
            .catch(function (error) {
                setStatus(
                    error && error.message
                        ? error.message
                        : 'Could not reach the support service. Check your connection and try again.',
                    'error'
                );
            })
            .then(function () {
                els.submit.disabled = false;
            });
    });
})();
