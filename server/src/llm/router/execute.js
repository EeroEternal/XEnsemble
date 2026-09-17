function applyChosenModel(parsedBody, { chosenProvider, chosenModel }) {
    if (chosenProvider) {
        parsedBody.model = `${chosenProvider}/${chosenModel}`;
    }
    return parsedBody;
}

module.exports = { applyChosenModel };
