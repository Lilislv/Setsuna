export function removeGarbageTags(rawText: string): string {
    if (!rawText) return "";
    
    // „T„t„p„|„‘„u„} „„„u„s„y, „{„€„„„€„‚„„u „€„ƒ„„„p„r„|„‘„u„„ HTML/Unity („~„p„„‚„y„}„u„‚, <color=#FFFFFF>, <size=24>)
    let cleaned = rawText.replace(/<[^>]*>?/gm, '');
    
    // „T„q„y„‚„p„u„} „|„y„Š„~„y„u „„‚„€„q„u„|„ „y „„…„ƒ„„„„u „ƒ„„„‚„€„{„y „„€ „{„‚„p„‘„}
    return cleaned.trim();
}