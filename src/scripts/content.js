'use strict'

/* global chrome */

chrome.runtime.onMessage.addListener(onMessageReceived)

function onMessageReceived (message, sender, sendResponse) {
  switch (message.context) {
    case 'search':
      performSearch(message, sendResponse)
      break
    case 'highlight':
      findInPage(message.searchQuery)
      sendResponse()
      break
    case 'checkScriptStatus':
      sendResponse()
      break
  }
}

function performSearch (message, sendResponse) {
  const MAX_RESULTS = 1
  const RELEVANCE_WEIGHTS = { host: 4, url: 3, title: 2, content: 1 }

  const searchQuery = message.searchQuery.toLowerCase()
  const originalText = document.body.innerText.replace(/[\r\n\f]+/g, '\n').replace(/[ \t]+/g, ' ')
  const pageText = originalText.toLowerCase()
  let relevanceScore = 0
  let matchFoundAnywhere = false

  const urlMatch = document.location.href.toLowerCase().includes(searchQuery)
  const hostMatch = document.location.hostname.toLowerCase().includes(searchQuery)
  const titleMatch = document.title.toLowerCase().includes(searchQuery)

  relevanceScore += hostMatch ? RELEVANCE_WEIGHTS.host : (urlMatch ? RELEVANCE_WEIGHTS.url : 0)
  relevanceScore += titleMatch ? RELEVANCE_WEIGHTS.title : 0
  matchFoundAnywhere = urlMatch || titleMatch

  const results = []
  let index = 0

  while ((index = pageText.indexOf(searchQuery, index)) !== -1) {
    const originalIndex = index
    const queryEndIndex = index + searchQuery.length
    const snippet = getSnippet(originalText, index, queryEndIndex).replace(/\s+/g, ' ')

    results.push({ snippet, relevanceScore })
    index = originalIndex + searchQuery.length
    matchFoundAnywhere = true
    if (results.length === MAX_RESULTS) break
  }

  if (results.length > 0) relevanceScore += RELEVANCE_WEIGHTS.content
  sendResponse({ searchId: message.searchId, results, matchFoundAnywhere, relevanceScore })
}

function getSnippet (originalText, queryStartIndex, queryEndIndex) {
  const MAX_CHARS_BEFORE = 40
  const MAX_CHARS_AFTER = 60

  // Calculate the initial boundaries for snippet extraction
  let snippetStart = Math.max(queryStartIndex - MAX_CHARS_BEFORE, 0)
  let snippetEnd = Math.min(queryEndIndex + MAX_CHARS_AFTER, originalText.length)

  let addEllipsisBefore = false
  let addEllipsisAfter = false

  // Search for newline before the start index only if needed
  if (snippetStart > 0) {
    const beforeRangeStart = Math.max(queryStartIndex - MAX_CHARS_BEFORE, 0)
    const newlineBefore = originalText.lastIndexOf('\n', queryStartIndex - 1)
    if (newlineBefore >= beforeRangeStart) {
      snippetStart = newlineBefore + 1
    } else {
      const spaceIndexBefore = originalText.lastIndexOf(' ', snippetStart)
      snippetStart = spaceIndexBefore !== -1 ? spaceIndexBefore + 1 : snippetStart
      addEllipsisBefore = true
    }
  }

  // Search for newline after the end index only if needed
  if (snippetEnd < originalText.length) {
    const afterRangeEnd = Math.min(queryEndIndex + MAX_CHARS_AFTER, originalText.length)
    const newlineAfter = originalText.indexOf('\n', queryEndIndex)
    if (newlineAfter !== -1 && newlineAfter < afterRangeEnd) {
      snippetEnd = newlineAfter
    } else {
      const spaceIndexAfter = originalText.indexOf(' ', snippetEnd)
      snippetEnd = spaceIndexAfter !== -1 ? spaceIndexAfter : snippetEnd
      addEllipsisAfter = true
    }
  }

  let snippet = originalText.substring(snippetStart, snippetEnd).trim()
  snippet = (addEllipsisBefore ? '…' : '') + snippet + (addEllipsisAfter ? '…' : '')

  return snippet
}

function findInPage (query, caseSensitive = false) {
  if (window.getSelection) {
    if (window.getSelection().empty) {
      window.getSelection().empty()
    } else if (window.getSelection().removeAllRanges) {
      window.getSelection().removeAllRanges()
    }
  } else if (document.selection) {
    document.selection.empty()
  }

  window.find(query, caseSensitive)
}
