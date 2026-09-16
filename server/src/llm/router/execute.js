function applyChosenModel(parsedBody, { chosenProvider, chosenModel }) {
    if (chosenProvider) {
        parsedBody.model = `${chosenProvider}/${chosenModel}`;
    } else {
        parsedBody.model = chosenModel;
    }
    return parsedBody;
}

module.exports = { applyChosenModel };
