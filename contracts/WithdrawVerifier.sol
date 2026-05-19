// SPDX-License-Identifier: GPL-3.0
/*
    Copyright 2021 0KIMS association.

    This file is generated with [snarkJS](https://github.com/iden3/snarkjs).

    snarkJS is a free software: you can redistribute it and/or modify it
    under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    snarkJS is distributed in the hope that it will be useful, but WITHOUT
    ANY WARRANTY; without even the implied warranty of MERCHANTABILITY
    or FITNESS FOR A PARTICULAR PURPOSE. See the GNU General Public
    License for more details.

    You should have received a copy of the GNU General Public License
    along with snarkJS. If not, see <https://www.gnu.org/licenses/>.
*/

pragma solidity >=0.7.0 <0.9.0;

contract WithdrawVerifier {
    // Scalar field size
    uint256 constant r    = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
    // Base field size
    uint256 constant q   = 21888242871839275222246405745257275088696311157297823662689037894645226208583;

    // Verification Key data
    uint256 constant alphax  = 20491192805390485299153009773594534940189261866228447918068658471970481763042;
    uint256 constant alphay  = 9383485363053290200918347156157836566562967994039712273449902621266178545958;
    uint256 constant betax1  = 4252822878758300859123897981450591353533073413197771768651442665752259397132;
    uint256 constant betax2  = 6375614351688725206403948262868962793625744043794305715222011528459656738731;
    uint256 constant betay1  = 21847035105528745403288232691147584728191162732299865338377159692350059136679;
    uint256 constant betay2  = 10505242626370262277552901082094356697409835680220590971873171140371331206856;
    uint256 constant gammax1 = 11559732032986387107991004021392285783925812861821192530917403151452391805634;
    uint256 constant gammax2 = 10857046999023057135944570762232829481370756359578518086990519993285655852781;
    uint256 constant gammay1 = 4082367875863433681332203403145435568316851327593401208105741076214120093531;
    uint256 constant gammay2 = 8495653923123431417604973247489272438418190587263600148770280649306958101930;
    uint256 constant deltax1 = 5011828930682333602199860404201677616572644803169750759527684156393910897289;
    uint256 constant deltax2 = 11586125326916076753991569691819293970926323194972183833573061458865962035102;
    uint256 constant deltay1 = 8448392041887937904784499743362552662683998238882240689413678473540691272684;
    uint256 constant deltay2 = 7801757105691741572152833002616357666523976313075107491397034704596544568408;

    
    uint256 constant IC0x = 21500863359423755339322369488379877087356655919358724816408459097877663179024;
    uint256 constant IC0y = 9321538567302677567952988268103705542339704890379094033693372711922356030650;
    
    uint256 constant IC1x = 20497524499645265979125590860599454800518950928731762765820843027905454985037;
    uint256 constant IC1y = 15658452745287106734544479669874309286080488382377371115339073908700168257073;
    
    uint256 constant IC2x = 1968538101562098622828855308449124897535423928280549180810573486310533711598;
    uint256 constant IC2y = 12468544138173956231237087330100794960922131053186441191801179747567978555508;
    
    uint256 constant IC3x = 5938713546245076457785756036787032828209342244609306856804795495500099766446;
    uint256 constant IC3y = 4164759515603689925413182769647437619285250523817576737911330764977511418435;
    
    uint256 constant IC4x = 6431270894628306841043628804355800116705313989060364297388306710697020762837;
    uint256 constant IC4y = 19473074517207495384961818740016514595791104208723828330038315878416050530757;
    
    uint256 constant IC5x = 1269189650907177648284861886658751009681214154551358731851003325088784542676;
    uint256 constant IC5y = 18313991068218619446833579885396003804173208727041768452628394600079721937312;
    
    uint256 constant IC6x = 12485847380208631835131030245006973188036473002052660242768074516628461150695;
    uint256 constant IC6y = 6132951027658098602197243626929181474775111998360405796853420849963428588900;
    
    uint256 constant IC7x = 21480555234581285161620469706999983041520222451559126104053213805204951981077;
    uint256 constant IC7y = 11540537841879278602499151614686696385344050988165544762806851161972199546838;
    
    uint256 constant IC8x = 1205424598277022001729205424212794706337424402500037895114634133471611719196;
    uint256 constant IC8y = 16274285792553556491043136649186086235628069577585835891490023180551867908340;
    
    uint256 constant IC9x = 6529291998555278313470907038457036556128139217795961718792759421848813345720;
    uint256 constant IC9y = 18996438076813699007448697657510993604512300327387516218591482799028154843283;
    
    uint256 constant IC10x = 2584907614008490654822060498013357373689924903416663062868117026885492783866;
    uint256 constant IC10y = 18230173585846317245493358039454552346809120062365650127180228423683772101312;
    
    uint256 constant IC11x = 16796195812570901877405677526564570985100761451882041048734405000181900386365;
    uint256 constant IC11y = 6968407294945094527165429473198160261026026714869262519381194021089471367805;
    
    uint256 constant IC12x = 16562996322761018255104072544857103042218855122774788049547145640441977498232;
    uint256 constant IC12y = 77517310820802135029811602663708443772947114492898842610008680452965645204;
    
    uint256 constant IC13x = 16208542886151096093925199648218749704598395629046164114079436598839503568318;
    uint256 constant IC13y = 4113750592577711428496863602344125599119094849346988815102396351216427236958;
    
    uint256 constant IC14x = 15658593230061016684109083565658114263845919597941245411647174217617985394896;
    uint256 constant IC14y = 2972835003357191630891080253413938468153053800209519549921334226011222456504;
    
    uint256 constant IC15x = 14879869340498953151942050912206343389663215311584121407457726653548798487128;
    uint256 constant IC15y = 3995467631633172307795113295496155914902216654520186990819855778224330795068;
    
    uint256 constant IC16x = 631972374908322635794100682079570372504740271143733513622906839315848944585;
    uint256 constant IC16y = 12987241050345325048814124029192900086007839559681661201006765690593238633781;
    
    uint256 constant IC17x = 17521922899519827426968365934325115485671147410164523566281877307011133350427;
    uint256 constant IC17y = 20640960582065673171466931487131972073556347760437272479801472918105254421275;
    
    uint256 constant IC18x = 1221042176539836460494578220309341368450638879118159005809332712375085494443;
    uint256 constant IC18y = 8601458047102604109070317720212576152765171060581215679266481034426037386740;
    
    uint256 constant IC19x = 15759593699936764973161420035888484600305997506826361822975186198621516259361;
    uint256 constant IC19y = 6350762478460099254576330192901243036315450239267179913924590272186935741735;
    
 
    // Memory data
    uint16 constant pVk = 0;
    uint16 constant pPairing = 128;

    uint16 constant pLastMem = 896;

    function verifyProof(uint[2] calldata _pA, uint[2][2] calldata _pB, uint[2] calldata _pC, uint[19] calldata _pubSignals) public view returns (bool) {
        assembly {
            function checkField(v) {
                if iszero(lt(v, r)) {
                    mstore(0, 0)
                    return(0, 0x20)
                }
            }
            
            // G1 function to multiply a G1 value(x,y) to value in an address
            function g1_mulAccC(pR, x, y, s) {
                let success
                let mIn := mload(0x40)
                mstore(mIn, x)
                mstore(add(mIn, 32), y)
                mstore(add(mIn, 64), s)

                success := staticcall(sub(gas(), 2000), 7, mIn, 96, mIn, 64)

                if iszero(success) {
                    mstore(0, 0)
                    return(0, 0x20)
                }

                mstore(add(mIn, 64), mload(pR))
                mstore(add(mIn, 96), mload(add(pR, 32)))

                success := staticcall(sub(gas(), 2000), 6, mIn, 128, pR, 64)

                if iszero(success) {
                    mstore(0, 0)
                    return(0, 0x20)
                }
            }

            function checkPairing(pA, pB, pC, pubSignals, pMem) -> isOk {
                let _pPairing := add(pMem, pPairing)
                let _pVk := add(pMem, pVk)

                mstore(_pVk, IC0x)
                mstore(add(_pVk, 32), IC0y)

                // Compute the linear combination vk_x
                
                g1_mulAccC(_pVk, IC1x, IC1y, calldataload(add(pubSignals, 0)))
                
                g1_mulAccC(_pVk, IC2x, IC2y, calldataload(add(pubSignals, 32)))
                
                g1_mulAccC(_pVk, IC3x, IC3y, calldataload(add(pubSignals, 64)))
                
                g1_mulAccC(_pVk, IC4x, IC4y, calldataload(add(pubSignals, 96)))
                
                g1_mulAccC(_pVk, IC5x, IC5y, calldataload(add(pubSignals, 128)))
                
                g1_mulAccC(_pVk, IC6x, IC6y, calldataload(add(pubSignals, 160)))
                
                g1_mulAccC(_pVk, IC7x, IC7y, calldataload(add(pubSignals, 192)))
                
                g1_mulAccC(_pVk, IC8x, IC8y, calldataload(add(pubSignals, 224)))
                
                g1_mulAccC(_pVk, IC9x, IC9y, calldataload(add(pubSignals, 256)))
                
                g1_mulAccC(_pVk, IC10x, IC10y, calldataload(add(pubSignals, 288)))
                
                g1_mulAccC(_pVk, IC11x, IC11y, calldataload(add(pubSignals, 320)))
                
                g1_mulAccC(_pVk, IC12x, IC12y, calldataload(add(pubSignals, 352)))
                
                g1_mulAccC(_pVk, IC13x, IC13y, calldataload(add(pubSignals, 384)))
                
                g1_mulAccC(_pVk, IC14x, IC14y, calldataload(add(pubSignals, 416)))
                
                g1_mulAccC(_pVk, IC15x, IC15y, calldataload(add(pubSignals, 448)))
                
                g1_mulAccC(_pVk, IC16x, IC16y, calldataload(add(pubSignals, 480)))
                
                g1_mulAccC(_pVk, IC17x, IC17y, calldataload(add(pubSignals, 512)))
                
                g1_mulAccC(_pVk, IC18x, IC18y, calldataload(add(pubSignals, 544)))
                
                g1_mulAccC(_pVk, IC19x, IC19y, calldataload(add(pubSignals, 576)))
                

                // -A
                mstore(_pPairing, calldataload(pA))
                mstore(add(_pPairing, 32), mod(sub(q, calldataload(add(pA, 32))), q))

                // B
                mstore(add(_pPairing, 64), calldataload(pB))
                mstore(add(_pPairing, 96), calldataload(add(pB, 32)))
                mstore(add(_pPairing, 128), calldataload(add(pB, 64)))
                mstore(add(_pPairing, 160), calldataload(add(pB, 96)))

                // alpha1
                mstore(add(_pPairing, 192), alphax)
                mstore(add(_pPairing, 224), alphay)

                // beta2
                mstore(add(_pPairing, 256), betax1)
                mstore(add(_pPairing, 288), betax2)
                mstore(add(_pPairing, 320), betay1)
                mstore(add(_pPairing, 352), betay2)

                // vk_x
                mstore(add(_pPairing, 384), mload(add(pMem, pVk)))
                mstore(add(_pPairing, 416), mload(add(pMem, add(pVk, 32))))


                // gamma2
                mstore(add(_pPairing, 448), gammax1)
                mstore(add(_pPairing, 480), gammax2)
                mstore(add(_pPairing, 512), gammay1)
                mstore(add(_pPairing, 544), gammay2)

                // C
                mstore(add(_pPairing, 576), calldataload(pC))
                mstore(add(_pPairing, 608), calldataload(add(pC, 32)))

                // delta2
                mstore(add(_pPairing, 640), deltax1)
                mstore(add(_pPairing, 672), deltax2)
                mstore(add(_pPairing, 704), deltay1)
                mstore(add(_pPairing, 736), deltay2)


                let success := staticcall(sub(gas(), 2000), 8, _pPairing, 768, _pPairing, 0x20)

                isOk := and(success, mload(_pPairing))
            }

            let pMem := mload(0x40)
            mstore(0x40, add(pMem, pLastMem))

            // Validate that all evaluations ∈ F
            
            checkField(calldataload(add(_pubSignals, 0)))
            
            checkField(calldataload(add(_pubSignals, 32)))
            
            checkField(calldataload(add(_pubSignals, 64)))
            
            checkField(calldataload(add(_pubSignals, 96)))
            
            checkField(calldataload(add(_pubSignals, 128)))
            
            checkField(calldataload(add(_pubSignals, 160)))
            
            checkField(calldataload(add(_pubSignals, 192)))
            
            checkField(calldataload(add(_pubSignals, 224)))
            
            checkField(calldataload(add(_pubSignals, 256)))
            
            checkField(calldataload(add(_pubSignals, 288)))
            
            checkField(calldataload(add(_pubSignals, 320)))
            
            checkField(calldataload(add(_pubSignals, 352)))
            
            checkField(calldataload(add(_pubSignals, 384)))
            
            checkField(calldataload(add(_pubSignals, 416)))
            
            checkField(calldataload(add(_pubSignals, 448)))
            
            checkField(calldataload(add(_pubSignals, 480)))
            
            checkField(calldataload(add(_pubSignals, 512)))
            
            checkField(calldataload(add(_pubSignals, 544)))
            
            checkField(calldataload(add(_pubSignals, 576)))
            

            // Validate all evaluations
            let isValid := checkPairing(_pA, _pB, _pC, _pubSignals, pMem)

            mstore(0, isValid)
             return(0, 0x20)
         }
     }
 }
