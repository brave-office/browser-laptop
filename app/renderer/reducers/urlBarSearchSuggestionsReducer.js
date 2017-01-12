/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

'use strict'

const windowConstants = require('../../../js/constants/windowConstants')
const debounce = require('../../../js/lib/debounce')
const getSetting = require('../../../js/settings').getSetting
const fetchSearchSuggestions = require('../fetchSearchSuggestions')
const {activeFrameStatePath, frameStatePath, getFrameKeyByTabId, getActiveFrame} = require('../../../js/state/frameStateUtil')
const searchProviders = require('../../../js/data/searchProviders')
const settings = require('../../../js/constants/settings')
const {isUrl} = require('../../../js/lib/appUrlUtil')
const Immutable = require('immutable')

const updateSearchEngineInfoFromInput = (state, frameProps) => {
  const input = frameProps.getIn(['navbar', 'urlbar', 'location'])
  const frameSearchDetail = frameProps.getIn(['navbar', 'urlbar', 'searchDetail'])
  if (input && input.length > 0) {
    const isLocationUrl = isUrl(input)
    if (!isLocationUrl &&
      !(frameSearchDetail && input.startsWith(frameSearchDetail.get('shortcut') + ' '))) {
      let entries = searchProviders.providers
      entries.forEach((entry) => {
        if (input.startsWith(entry.shortcut + ' ')) {
          state = state.setIn(
            frameStatePath(state, frameProps.get('key')).concat(['navbar', 'urlbar', 'searchDetail']),
            Object.assign({}, entry, { activateSearchEngine: true }))
        }
      })
    }
  }
  return state
}

const searchXHR = (state, frameProps, searchOnline) => {
  const searchDetail = state.get('searchDetail')
  const frameSearchDetail = frameProps.getIn(['navbar', 'urlbar', 'searchDetail'])
  let autocompleteURL = frameSearchDetail
    ? frameSearchDetail.get('autocomplete')
    : searchDetail.get('autocompleteURL')
  if (!getSetting(settings.OFFER_SEARCH_SUGGESTIONS) || !autocompleteURL) {
    state = state.setIn(activeFrameStatePath(state).concat(['navbar', 'urlbar', 'suggestions', 'searchResults']), Immutable.fromJS([]))
    return state
  }

  let input = frameProps.getIn(['navbar', 'urlbar', 'location'])
  if (!isUrl(input) && input.length > 0) {
    if (searchDetail) {
      const replaceRE = new RegExp('^' + searchDetail.get('shortcut') + ' ', 'g')
      input = input.replace(replaceRE, '')
    }

    if (searchOnline) {
      fetchSearchSuggestions(frameProps.get('tabId'), autocompleteURL, input)
    }
  } else {
    state = state.setIn(activeFrameStatePath(state).concat(['navbar', 'urlbar', 'suggestions', 'searchResults']), Immutable.fromJS([]))
  }
  return state
}

const getNewSuggestionList = (props) => {
  props = props || this.props
  if (!props.urlLocation && !props.urlPreview) {
    return null
  }

  const navigateClickHandler = (formatUrl) => (site, e) => {
    // We have a wonky way of fake clicking from keyboard enter,
    // so remove the meta keys from the real event here.
    e.metaKey = e.metaKey || this.metaKey
    e.ctrlKey = e.ctrlKey || this.ctrlKey
    e.shiftKey = e.shiftKey || this.shiftKey
    delete this.metaKey
    delete this.ctrlKey
    delete this.shiftKey

    const location = formatUrl(site)
    // When clicked make sure to hide autocomplete
    windowActions.setRenderUrlBarSuggestions(false)
    if (eventUtil.isForSecondaryAction(e)) {
      windowActions.newFrame({
        location,
        partitionNumber: site && site.get && site.get('partitionNumber') || undefined
      }, !!e.shiftKey)
      e.preventDefault()
    } else {
      windowActions.loadUrl(this.activeFrame, location)
      windowActions.setUrlBarActive(false)
      windowActions.setUrlBarPreview(null)
      this.blur()
    }
  }

  const urlLocationLower = props.urlLocation.toLowerCase()
  let suggestions = new Immutable.List()
  const defaultme = (x) => x
  const mapListToElements = ({data, maxResults, type, clickHandler = navigateClickHandler,
      sortHandler = defaultme, formatTitle = defaultme, formatUrl = defaultme,
      filterValue = (site) => site.toLowerCase().includes(urlLocationLower)
  }) => // Filter out things which are already in our own list at a smaller index
    data
    // Per suggestion provider filter
    .filter(filterValue)
    // Filter out things which are already in the suggestions list
    .filter((site) =>
      suggestions.findIndex((x) => (x.location || '').toLowerCase() === (formatUrl(site) || '').toLowerCase()) === -1 ||
        // Tab autosuggestions should always be included since they will almost always be in history
        type === suggestionTypes.TAB)
    .sort(sortHandler)
    .take(maxResults)
    .map((site) => {
      return {
        onClick: clickHandler.bind(null, site),
        title: formatTitle(site),
        location: formatUrl(site),
        type
      }
    })

  const shouldNormalize = suggestion.shouldNormalizeLocation(urlLocationLower)
  const urlLocationLowerNormalized = suggestion.normalizeLocation(urlLocationLower)
  const sortBasedOnLocationPos = (s1, s2) => {
    const location1 = shouldNormalize ? suggestion.normalizeLocation(s1.get('location')) : s1.get('location')
    const location2 = shouldNormalize ? suggestion.normalizeLocation(s2.get('location')) : s2.get('location')
    const pos1 = location1.indexOf(urlLocationLowerNormalized)
    const pos2 = location2.indexOf(urlLocationLowerNormalized)
    if (pos1 === -1 && pos2 === -1) {
      return 0
    } else if (pos1 === -1) {
      return 1
    } else if (pos2 === -1) {
      return -1
    } else {
      if (pos1 - pos2 !== 0) {
        return pos1 - pos2
      } else {
        // sort site.com higher than site.com/somepath
        const sdnv1 = suggestion.simpleDomainNameValue(s1)
        const sdnv2 = suggestion.simpleDomainNameValue(s2)
        if (sdnv1 !== sdnv2) {
          return sdnv2 - sdnv1
        } else {
          // If there's a tie on the match location, use the age
          // decay modified access count
          return suggestion.sortByAccessCountWithAgeDecay(s1, s2)
        }
      }
    }
  }

  const historyFilter = (site) => {
    if (!site) {
      return false
    }
    const title = site.get('title') || ''
    const location = site.get('location') || ''
    // Note: Bookmark sites are now included in history. This will allow
    // sites to appear in the auto-complete regardless of their bookmark
    // status. If history is turned off, bookmarked sites will appear
    // in the bookmark section.
    return (title.toLowerCase().includes(urlLocationLower) ||
            location.toLowerCase().includes(urlLocationLower)) &&
            site.get('lastAccessedTime')
  }
  var historySites = props.sites.filter(historyFilter)

  // potentially append virtual history items (such as www.google.com when
  // searches have been made but the root site has not been visited)
  historySites = historySites.concat(suggestion.createVirtualHistoryItems(historySites))

  // history
  if (getSetting(settings.HISTORY_SUGGESTIONS)) {
    suggestions = suggestions.concat(mapListToElements({
      data: historySites,
      maxResults: config.urlBarSuggestions.maxHistorySites,
      type: suggestionTypes.HISTORY,
      clickHandler: navigateClickHandler((site) => {
        return site.get('location')
      }),
      sortHandler: sortBasedOnLocationPos,
      formatTitle: (site) => site.get('title'),
      formatUrl: (site) => site.get('location'),
      filterValue: historyFilter
    }))
  }

  // bookmarks
  if (getSetting(settings.BOOKMARK_SUGGESTIONS)) {
    suggestions = suggestions.concat(mapListToElements({
      data: props.sites,
      maxResults: config.urlBarSuggestions.maxBookmarkSites,
      type: suggestionTypes.BOOKMARK,
      clickHandler: navigateClickHandler((site) => {
        return site.get('location')
      }),
      sortHandler: sortBasedOnLocationPos,
      formatTitle: (site) => site.get('title'),
      formatUrl: (site) => site.get('location'),
      filterValue: (site) => {
        const title = site.get('title') || ''
        const location = site.get('location') || ''
        return (title.toLowerCase().includes(urlLocationLower) ||
          location.toLowerCase().includes(urlLocationLower)) &&
          site.get('tags') && site.get('tags').includes(siteTags.BOOKMARK)
      }
    }))
  }

  // about pages
  suggestions = suggestions.concat(mapListToElements({
    data: aboutUrls.keySeq().filter((x) => isNavigatableAboutPage(x)),
    maxResults: config.urlBarSuggestions.maxAboutPages,
    type: suggestionTypes.ABOUT_PAGES,
    clickHandler: navigateClickHandler((x) => x)}))

  // opened frames
  if (getSetting(settings.OPENED_TAB_SUGGESTIONS)) {
    suggestions = suggestions.concat(mapListToElements({
      data: windowStore.getFrames(),
      maxResults: config.urlBarSuggestions.maxOpenedFrames,
      type: suggestionTypes.TAB,
      clickHandler: (frameProps) =>
        windowActions.setActiveFrame(frameProps),
      sortHandler: sortBasedOnLocationPos,
      formatTitle: (frame) => frame.get('title'),
      formatUrl: (frame) => frame.get('location'),
      filterValue: (frame) => !isSourceAboutUrl(frame.get('location')) &&
        frame.get('key') !== props.activeFrameKey &&
        (frame.get('title') && frame.get('title').toLowerCase().includes(urlLocationLower) ||
        frame.get('location') && frame.get('location').toLowerCase().includes(urlLocationLower))}))
  }

  // Search suggestions
  if (getSetting(settings.OFFER_SEARCH_SUGGESTIONS) && props.searchResults) {
    suggestions = suggestions.concat(mapListToElements({
      data: props.searchResults,
      maxResults: config.urlBarSuggestions.maxSearch,
      type: suggestionTypes.SEARCH,
      clickHandler: navigateClickHandler((searchTerms) => {
        let searchURL = props.searchSelectEntry
        ? props.searchSelectEntry.search : props.searchDetail.get('searchURL')
        return searchURL.replace('{searchTerms}', encodeURIComponent(searchTerms))
      })
    }))
  }

  // Alexa top 500
  suggestions = suggestions.concat(mapListToElements({
    data: top500,
    maxResults: config.urlBarSuggestions.maxTopSites,
    type: suggestionTypes.TOP_SITE,
    clickHandler: navigateClickHandler((x) => x)}))

  return suggestions
}

const urlBarSearchSuggestionsReducer = (state, action) => {
  switch (action.actionType) {
    case windowConstants.WINDOW_SET_URL:
      state = state.setIn(activeFrameStatePath(state).concat(['navbar', 'urlbar', 'suggestions', 'searchResults']), Immutable.fromJS([]))
      break
    case windowConstants.WINDOW_SEARCH_SUGGESTION_RESULTS_AVAILABLE:
      const frameKey = getFrameKeyByTabId(state, action.tabId)
      state = state.setIn(frameStatePath(state, frameKey).concat(['navbar', 'urlbar', 'suggestions', 'searchResults']), action.searchResults)
      break
    case windowConstants.WINDOW_SET_NAVBAR_INPUT:
      const activeFrameProps = getActiveFrame(state)
      // frameProps will be filled in by this point
      state = updateSearchEngineInfoFromInput(state, activeFrameProps)
      state = searchXHR(state, activeFrameProps, true)
      break
    case windowConstants.WINDOW_SEARCH_SUGGESTIONS_CLEARED:
      state = state.deleteIn(activeFrameStatePath(state).concat(['navbar', 'urlbar', 'searchDetail']))
      break
    default:
      return state
  }
  return state
}

module.exports = urlBarSearchSuggestionsReducer
